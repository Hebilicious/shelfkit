//! `shelfkit serve`: the shelf as an OpenAPM registry on `http://127.0.0.1`.
//!
//! Every profile is packaged ([`crate::package`]) and published into an
//! in-memory registry when the server starts; `PUT` publishes more while it
//! runs. Nothing is written to disk and nothing survives a restart: the
//! hosted service is the durable registry.
//!
//! The protocol is `shelfkit_registry`'s, the same the Worker runs. This
//! module is only HTTP/1.1 over a blocking socket: one thread per
//! connection, one request per connection, no async runtime. It binds to
//! loopback alone, because APM 0.33.0 accepts plain `http://` only there.

use shelfkit_registry::host::{HttpResponse, MemoryKeys, MemoryStore, Registry, Request};
use shelfkit_registry::{PackageId, Scope, archive};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// The environment variable `serve` reads keys from: whitespace-separated
/// `SCOPES=KEY` entries, as `--key` takes them.
pub const KEYS_ENV: &str = "SHELFKIT_SERVE_KEYS";

/// The largest request head the server reads.
const MAX_HEAD: usize = 64 * 1024;

/// Parse one `SCOPES=KEY` entry: comma-separated scopes, then the key.
/// The key is everything after the first `=`, so it may contain `=`.
pub fn parse_key(entry: &str) -> Result<(String, Vec<Scope>), String> {
    let Some((scopes, key)) = entry.split_once('=') else {
        return Err(
            "a key is `SCOPES=KEY`, as `read,publish:acme/*=<key>` (the key itself is not shown)"
                .to_owned(),
        );
    };
    if key.is_empty() {
        return Err(format!("the key for `{scopes}` is empty"));
    }
    let scopes = scopes
        .split(',')
        .map(Scope::parse)
        .collect::<Result<Vec<_>, _>>()?;
    Ok((key.to_owned(), scopes))
}

/// The registry `serve` runs, shared between connection threads.
pub type Shared = Arc<Mutex<Registry<MemoryStore, MemoryKeys>>>;

/// Bind to `127.0.0.1:port` (`0` picks a free port).
pub fn bind(port: u16) -> std::io::Result<TcpListener> {
    TcpListener::bind((Ipv4Addr::LOCALHOST, port))
}

/// Serve until the process ends, logging one line per request (method,
/// path, status; never a header) to `log`.
pub fn run(listener: &TcpListener, registry: &Shared, log: &Arc<Mutex<dyn Write + Send>>) {
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        let registry = Arc::clone(registry);
        let log = Arc::clone(log);
        std::thread::spawn(move || connection(stream, &registry, &log));
    }
}

fn connection(stream: TcpStream, registry: &Shared, log: &Arc<Mutex<dyn Write + Send>>) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(30)));
    let Ok(writer) = stream.try_clone() else {
        return;
    };
    let mut reader = BufReader::new(stream);
    let mut writer = writer;
    let (line, response) = match read_request(&mut reader, &mut writer) {
        Ok(request) => {
            let line = format!("{} {}", request.method, request.path);
            let response = match registry.lock() {
                Ok(mut registry) => registry.handle(&request, &now()),
                Err(_) => internal("the registry is unavailable after an earlier failure"),
            };
            (line, response)
        }
        Err(response) => ("<unreadable request>".to_owned(), *response),
    };
    if let Ok(mut log) = log.lock() {
        let _ = writeln!(log, "{line} -> {}", response.status);
    }
    let _ = write_response(&mut writer, &response);
}

/// Read one request: the head, then a `Content-Length` body.
fn read_request(
    reader: &mut BufReader<TcpStream>,
    writer: &mut TcpStream,
) -> Result<Request, Box<HttpResponse>> {
    let mut head = Vec::new();
    loop {
        let mut line = Vec::new();
        let read = reader
            .by_ref()
            .take((MAX_HEAD - head.len()) as u64 + 1)
            .read_until(b'\n', &mut line)
            .map_err(|_| bad_request("the request could not be read"))?;
        if read == 0 {
            return Err(bad_request(
                "the connection closed before the request ended",
            ));
        }
        head.extend_from_slice(&line);
        if head.len() > MAX_HEAD {
            return Err(problem(431, "header-too-large", "Request header too large"));
        }
        if line == b"\r\n" || line == b"\n" {
            break;
        }
    }
    let text = String::from_utf8(head).map_err(|_| bad_request("the request head is not UTF-8"))?;
    let mut lines = text.lines();
    let request_line = lines.next().unwrap_or_default();
    let mut parts = request_line.split(' ');
    let (Some(method), Some(path), Some(version)) = (parts.next(), parts.next(), parts.next())
    else {
        return Err(bad_request(
            "the request line is not `METHOD PATH HTTP/1.1`",
        ));
    };
    if !version.starts_with("HTTP/1.") {
        return Err(problem(505, "http-version", "HTTP version not supported"));
    }
    let mut headers = Vec::new();
    for line in lines.filter(|line| !line.is_empty()) {
        let Some((name, value)) = line.split_once(':') else {
            return Err(bad_request("a header line has no `:`"));
        };
        headers.push((name.trim().to_owned(), value.trim().to_owned()));
    }
    let mut request = Request {
        method: method.to_owned(),
        path: path.to_owned(),
        headers,
        body: Vec::new(),
    };
    if request
        .header("transfer-encoding")
        .is_some_and(|value| !value.eq_ignore_ascii_case("identity"))
    {
        return Err(problem(
            411,
            "length-required",
            "Send the body with a Content-Length",
        ));
    }
    let length = match request.header("content-length") {
        None => 0,
        Some(value) => value
            .parse::<usize>()
            .map_err(|_| bad_request("Content-Length is not a number"))?,
    };
    if length > archive::MAX_ARCHIVE_BYTES {
        return Err(problem(413, "too-large", "Archive too large"));
    }
    if length > 0 {
        if request
            .header("expect")
            .is_some_and(|value| value.eq_ignore_ascii_case("100-continue"))
        {
            let _ = writer.write_all(b"HTTP/1.1 100 Continue\r\n\r\n");
        }
        let mut body = vec![0; length];
        reader
            .read_exact(&mut body)
            .map_err(|_| bad_request("the body is shorter than its Content-Length"))?;
        request.body = body;
    }
    Ok(request)
}

fn write_response(writer: &mut TcpStream, response: &HttpResponse) -> std::io::Result<()> {
    let mut head = format!(
        "HTTP/1.1 {} {}\r\n",
        response.status,
        reason(response.status)
    );
    for (name, value) in &response.headers {
        if name.eq_ignore_ascii_case("content-length") {
            continue;
        }
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    if response.status != 304 {
        head.push_str(&format!("Content-Length: {}\r\n", response.body.len()));
    }
    head.push_str("Connection: close\r\n\r\n");
    writer.write_all(head.as_bytes())?;
    writer.write_all(&response.body)?;
    writer.flush()
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        304 => "Not Modified",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        411 => "Length Required",
        413 => "Content Too Large",
        415 => "Unsupported Media Type",
        422 => "Unprocessable Content",
        431 => "Request Header Fields Too Large",
        505 => "HTTP Version Not Supported",
        _ => "Internal Server Error",
    }
}

fn problem(status: u16, slug: &str, title: &str) -> Box<HttpResponse> {
    Box::new(error(status, slug, title, title))
}

fn bad_request(detail: &str) -> Box<HttpResponse> {
    Box::new(error(400, "bad-request", "Bad request", detail))
}

fn internal(detail: &str) -> HttpResponse {
    error(500, "internal", "Internal error", detail)
}

/// An RFC 7807 problem the HTTP layer answers by itself.
fn error(status: u16, slug: &str, title: &str, detail: &str) -> HttpResponse {
    let response = shelfkit_registry::protocol::problem(status, slug, title, detail, "");
    let body = match response.body {
        shelfkit_registry::Body::Json { text } => text.into_bytes(),
        shelfkit_registry::Body::Empty | shelfkit_registry::Body::Archive { .. } => Vec::new(),
    };
    HttpResponse {
        status,
        headers: response.headers,
        body,
    }
}

/// The current time, RFC 3339 in UTC to the second.
pub fn now() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs());
    rfc3339(seconds)
}

/// Seconds since the Unix epoch as `YYYY-MM-DDTHH:MM:SSZ`.
pub fn rfc3339(seconds: u64) -> String {
    let days = seconds / 86_400;
    let rest = seconds % 86_400;
    // Howard Hinnant's civil-from-days, for days since 1970-01-01.
    let z = days + 719_468;
    let era = z / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let mp = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = year_of_era + era * 400 + u64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rest / 3_600,
        rest % 3_600 / 60,
        rest % 60
    )
}

/// The `apm.yml` lines that install `package` at `version` from `url`.
pub fn install_snippet(url: &str, package: &PackageId, version: &str) -> String {
    format!(
        "registries:\n  shelfkit:\n    url: {url}\n  default: shelfkit\ndependencies:\n  apm:\n    - id: {}\n      version: \"{version}\"\n",
        package.name()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc3339_is_utc_calendar_time() {
        assert_eq!(rfc3339(0), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(rfc3339(1_792_411_200), "2026-10-19T12:00:00Z");
    }

    #[test]
    fn keys_are_scopes_then_the_key() {
        let (key, scopes) = parse_key("read,publish:acme/*=abc=def").unwrap();
        assert_eq!(key, "abc=def");
        assert_eq!(
            scopes,
            vec![Scope::Read, Scope::PublishOwner("acme".to_owned())]
        );
        assert!(parse_key("read").is_err());
        assert!(parse_key("read=").is_err());
        assert!(parse_key("write=x").is_err());
    }
}
