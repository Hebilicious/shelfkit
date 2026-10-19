//! HTTP for the hosted service's client: one blocking request at a time over
//! rustls, with no async runtime. Only [`super::HostSystem`] calls this.

use super::system::{HttpRequest, HttpResponse};
use std::io;
use std::time::Duration;

/// The largest answer read: a shelf object or a registry archive.
const MAX_BODY: u64 = 256 * 1024 * 1024;

pub fn send(request: &HttpRequest) -> io::Result<HttpResponse> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_global(Some(Duration::from_secs(120)))
        .user_agent(concat!("shelfkit/", env!("CARGO_PKG_VERSION")))
        .build()
        .into();
    let mut builder = ureq::http::Request::builder()
        .method(request.method)
        .uri(&request.url);
    for (name, value) in &request.headers {
        builder = builder.header(name, value);
    }
    let built = builder
        .body(request.body.clone())
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error.to_string()))?;
    let response = agent
        .run(built)
        .map_err(|error| io::Error::other(error.to_string()))?;
    let status = response.status().as_u16();
    let body = response
        .into_body()
        .with_config()
        .limit(MAX_BODY)
        .read_to_vec()
        .map_err(|error| io::Error::other(error.to_string()))?;
    Ok(HttpResponse { status, body })
}
