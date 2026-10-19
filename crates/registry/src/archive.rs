//! Package archives: `tar.gz`, written deterministically and read defensively.
//!
//! [`pack`] is a pure function of its files. Entries are regular files in
//! path order, with mode `0644`, owner `0:0`, no user or group names, and
//! modification time `0`, in POSIX `ustar` headers. The gzip member has no
//! file name, modification time `0`, operating system `255` (unknown), and
//! is compressed at level 9 by the pure-Rust backend. The CLI, the WASM
//! engine, and therefore the Worker produce the same bytes, and the same
//! `sha256:` digest, for the same files.
//!
//! [`read`] is what the registry runs on an upload before it stores it
//! (Registry HTTP API section 6). It accepts what common `tar` writers emit
//! (`ustar`, PAX `path` and `size` records, GNU long names) and refuses
//! anything an extractor could be tricked by: absolute paths, `..`, links,
//! devices, and a path that appears twice.

use flate2::Compression;
use flate2::GzBuilder;
use flate2::read::MultiGzDecoder;
use std::collections::BTreeMap;
use std::io::{Read, Write};

/// The one archive media type ShelfKit serves and accepts. APM's own
/// publisher uploads zip, but the archive format ShelfKit commits to is
/// `tar.gz` alone (`docs/PRD.md` section 7.1).
pub const CONTENT_TYPE: &str = "application/gzip";

/// The largest archive the registry stores: the Registry HTTP API's
/// suggested default.
pub const MAX_ARCHIVE_BYTES: usize = 50 * 1024 * 1024;

/// The largest an archive may inflate to, so a small upload cannot expand
/// without bound while it is checked.
pub const MAX_UNPACKED_BYTES: u64 = 256 * 1024 * 1024;

const BLOCK: usize = 512;

/// Why an archive could not be written or read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArchiveError {
    /// Not a gzip stream, or not a tar inside it: a `400`.
    Malformed(String),
    /// A well-formed archive with an entry an extractor must not write: a `422`.
    Unsafe(String),
    /// Over [`MAX_ARCHIVE_BYTES`] or [`MAX_UNPACKED_BYTES`]: a `413`.
    TooLarge(String),
}

impl std::fmt::Display for ArchiveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Malformed(message) | Self::Unsafe(message) | Self::TooLarge(message) => {
                f.write_str(message)
            }
        }
    }
}

/// Write `files` (path relative to the package root, and bytes) as a
/// deterministic `tar.gz`. A path must be relative, use `/`, have no empty,
/// `.`, or `..` component, and fit a `ustar` header (a name of at most 100
/// bytes after a directory prefix of at most 155).
pub fn pack(files: &BTreeMap<String, Vec<u8>>) -> Result<Vec<u8>, ArchiveError> {
    let mut tar = Vec::new();
    for (path, bytes) in files {
        check_path(path).map_err(ArchiveError::Unsafe)?;
        tar.extend_from_slice(&header(path, bytes.len())?);
        tar.extend_from_slice(bytes);
        tar.resize(tar.len().div_ceil(BLOCK) * BLOCK, 0);
    }
    // The end of the archive: two zero blocks.
    tar.resize(tar.len() + 2 * BLOCK, 0);

    let mut encoder = GzBuilder::new()
        .mtime(0)
        .operating_system(255)
        .write(Vec::new(), Compression::best());
    encoder.write_all(&tar).map_err(|error| {
        ArchiveError::Malformed(format!("cannot compress the archive: {error}"))
    })?;
    let gz = encoder.finish().map_err(|error| {
        ArchiveError::Malformed(format!("cannot compress the archive: {error}"))
    })?;
    if gz.len() > MAX_ARCHIVE_BYTES {
        return Err(ArchiveError::TooLarge(format!(
            "the archive is {} bytes; the registry stores at most {MAX_ARCHIVE_BYTES}",
            gz.len()
        )));
    }
    Ok(gz)
}

/// A `ustar` header for a regular file.
fn header(path: &str, size: usize) -> Result<[u8; BLOCK], ArchiveError> {
    let (prefix, name) = split_name(path).ok_or_else(|| {
        ArchiveError::Unsafe(format!(
            "`{path}` is too long for a ustar header (a name of at most 100 bytes in a directory of at most 155)"
        ))
    })?;
    let mut header = [0u8; BLOCK];
    header[..name.len()].copy_from_slice(name.as_bytes());
    header[100..108].copy_from_slice(b"0000644\0");
    header[108..116].copy_from_slice(b"0000000\0");
    header[116..124].copy_from_slice(b"0000000\0");
    let size = format!("{size:011o}\0");
    if size.len() != 12 {
        return Err(ArchiveError::TooLarge(format!(
            "`{path}` is too large for a ustar header"
        )));
    }
    header[124..136].copy_from_slice(size.as_bytes());
    header[136..148].copy_from_slice(b"00000000000\0");
    header[148..156].copy_from_slice(b"        ");
    header[156] = b'0';
    header[257..263].copy_from_slice(b"ustar\0");
    header[263..265].copy_from_slice(b"00");
    header[345..345 + prefix.len()].copy_from_slice(prefix.as_bytes());
    let sum: u32 = header.iter().map(|byte| u32::from(*byte)).sum();
    header[148..156].copy_from_slice(format!("{sum:06o}\0 ").as_bytes());
    Ok(header)
}

/// Split a path into a `ustar` prefix and name, at the last `/` that fits.
fn split_name(path: &str) -> Option<(&str, &str)> {
    if path.len() <= 100 {
        return Some(("", path));
    }
    path.match_indices('/')
        .map(|(index, _)| (&path[..index], &path[index + 1..]))
        .find(|(prefix, name)| prefix.len() <= 155 && name.len() <= 100 && !name.is_empty())
}

/// Check one path an archive will carry.
fn check_path(path: &str) -> Result<(), String> {
    if path.is_empty() {
        return Err("an entry has an empty path".to_owned());
    }
    if path.starts_with('/') || path.starts_with('\\') || path.as_bytes().get(1) == Some(&b':') {
        return Err(format!("`{path}` is an absolute path"));
    }
    if path.contains('\\') {
        return Err(format!("`{path}` contains a backslash"));
    }
    if path.chars().any(char::is_control) {
        return Err(format!(
            "`{}` contains a control character",
            path.escape_debug()
        ));
    }
    for component in path.split('/') {
        match component {
            "" | "." => return Err(format!("`{path}` has an empty or `.` component")),
            ".." => return Err(format!("`{path}` climbs out of the package with `..`")),
            _ => {}
        }
    }
    Ok(())
}

/// The regular files of an archive, by normalized path. Directories are
/// implied and not listed.
pub type Files = BTreeMap<String, Vec<u8>>;

/// Decompress and walk an uploaded archive, refusing anything unsafe.
pub fn read(archive: &[u8]) -> Result<Files, ArchiveError> {
    if archive.len() > MAX_ARCHIVE_BYTES {
        return Err(ArchiveError::TooLarge(format!(
            "the archive is {} bytes; the registry stores at most {MAX_ARCHIVE_BYTES}",
            archive.len()
        )));
    }
    if !archive.starts_with(&[0x1f, 0x8b]) {
        return Err(ArchiveError::Malformed(
            "the body is not a gzip stream (a tar.gz archive starts with 1f 8b)".to_owned(),
        ));
    }
    let mut tar = Vec::new();
    MultiGzDecoder::new(archive)
        .take(MAX_UNPACKED_BYTES + 1)
        .read_to_end(&mut tar)
        .map_err(|error| ArchiveError::Malformed(format!("the gzip stream is corrupt: {error}")))?;
    if tar.len() as u64 > MAX_UNPACKED_BYTES {
        return Err(ArchiveError::TooLarge(format!(
            "the archive inflates to more than {MAX_UNPACKED_BYTES} bytes"
        )));
    }
    walk(&tar)
}

/// Pending overrides for the next entry, from PAX or GNU headers.
#[derive(Default)]
struct Pending {
    path: Option<String>,
    size: Option<usize>,
}

fn walk(tar: &[u8]) -> Result<Files, ArchiveError> {
    let mut files = Files::new();
    let mut directories: Vec<String> = Vec::new();
    let mut pending = Pending::default();
    let mut offset = 0;
    loop {
        let Some(block) = tar.get(offset..offset + BLOCK) else {
            return Err(ArchiveError::Malformed(
                "the tar stream ends without its end-of-archive blocks".to_owned(),
            ));
        };
        if block.iter().all(|byte| *byte == 0) {
            break;
        }
        verify_checksum(block, offset)?;
        let kind = block[156];
        let header_size = octal(&block[124..136])
            .ok_or_else(|| malformed_at(offset, "has an unreadable size"))?;
        let size = if matches!(kind, b'x' | b'g' | b'L' | b'K') {
            header_size
        } else {
            pending.size.take().unwrap_or(header_size)
        };
        let start = offset + BLOCK;
        let data = tar
            .get(start..start.saturating_add(size))
            .ok_or_else(|| malformed_at(offset, "claims more data than the archive holds"))?;
        offset = start + size.div_ceil(BLOCK) * BLOCK;

        match kind {
            b'x' => {
                let records =
                    pax(data).ok_or_else(|| malformed_at(start, "has a corrupt PAX header"))?;
                for (key, value) in records {
                    match key.as_str() {
                        "path" => pending.path = Some(value),
                        "size" => {
                            pending.size = Some(value.parse().map_err(|_| {
                                malformed_at(start, "has a PAX size that is not a number")
                            })?);
                        }
                        "linkpath" => {
                            return Err(ArchiveError::Unsafe(
                                "the archive contains a link (a PAX `linkpath`)".to_owned(),
                            ));
                        }
                        _ => {}
                    }
                }
                continue;
            }
            // Global PAX records describe no single entry.
            b'g' => continue,
            b'L' => {
                pending.path = Some(c_string(data));
                continue;
            }
            _ => {}
        }

        let path = match pending.path.take() {
            Some(path) => path,
            None => header_path(block),
        };
        let normalized = normalize(&path).map_err(ArchiveError::Unsafe)?;
        match kind {
            b'0' | b'\0' | b'7' => {
                let Some(normalized) = normalized else {
                    return Err(ArchiveError::Unsafe(format!(
                        "`{path}` is a file at the archive's root directory itself"
                    )));
                };
                if directories.contains(&normalized) || files.contains_key(&normalized) {
                    return Err(ArchiveError::Unsafe(format!(
                        "`{normalized}` appears twice in the archive"
                    )));
                }
                files.insert(normalized, data.to_vec());
            }
            b'5' => {
                if let Some(normalized) = normalized {
                    if files.contains_key(&normalized) {
                        return Err(ArchiveError::Unsafe(format!(
                            "`{normalized}` appears twice in the archive"
                        )));
                    }
                    directories.push(normalized);
                }
            }
            b'1' | b'2' | b'K' => {
                return Err(ArchiveError::Unsafe(format!(
                    "`{path}` is a link; a package archive holds only files and directories"
                )));
            }
            b'3' | b'4' | b'6' => {
                return Err(ArchiveError::Unsafe(format!(
                    "`{path}` is a device or a FIFO; a package archive holds only files and directories"
                )));
            }
            other => {
                return Err(ArchiveError::Unsafe(format!(
                    "`{path}` has entry type `{}`, which the registry does not accept",
                    char::from(other).escape_debug()
                )));
            }
        }
    }
    Ok(files)
}

/// The path in a header: `prefix/name` for `ustar`, `name` otherwise.
fn header_path(block: &[u8]) -> String {
    let name = c_string(&block[..100]);
    let ustar = &block[257..262] == b"ustar";
    let prefix = if ustar {
        c_string(&block[345..500])
    } else {
        String::new()
    };
    if prefix.is_empty() {
        name
    } else {
        format!("{prefix}/{name}")
    }
}

/// Normalize an entry path: `./` and repeated `/` are dropped. `None` is the
/// root itself. Anything an extractor could be steered by is an error.
fn normalize(path: &str) -> Result<Option<String>, String> {
    if path.starts_with('/') || path.starts_with('\\') || path.as_bytes().get(1) == Some(&b':') {
        return Err(format!("`{path}` is an absolute path"));
    }
    if path.contains('\\') {
        return Err(format!("`{path}` contains a backslash"));
    }
    if path.chars().any(char::is_control) {
        return Err(format!(
            "`{}` contains a control character",
            path.escape_debug()
        ));
    }
    let mut parts = Vec::new();
    for component in path.split('/') {
        match component {
            "" | "." => {}
            ".." => return Err(format!("`{path}` climbs out of the package with `..`")),
            part => parts.push(part),
        }
    }
    Ok((!parts.is_empty()).then(|| parts.join("/")))
}

fn verify_checksum(block: &[u8], offset: usize) -> Result<(), ArchiveError> {
    let stored = octal(&block[148..156])
        .ok_or_else(|| malformed_at(offset, "has an unreadable checksum"))?;
    let sum: usize = block
        .iter()
        .enumerate()
        .map(|(index, byte)| {
            if (148..156).contains(&index) {
                usize::from(b' ')
            } else {
                usize::from(*byte)
            }
        })
        .sum();
    if sum == stored {
        Ok(())
    } else {
        Err(malformed_at(offset, "fails its checksum"))
    }
}

/// An octal header field, or GNU's base-256 form for large sizes.
fn octal(field: &[u8]) -> Option<usize> {
    if field.first().is_some_and(|byte| byte & 0x80 != 0) {
        let mut value: usize = usize::from(field[0] & 0x7f);
        for byte in &field[1..] {
            value = value.checked_mul(256)?.checked_add(usize::from(*byte))?;
        }
        return Some(value);
    }
    let text: String = field
        .iter()
        .take_while(|byte| **byte != 0)
        .map(|byte| char::from(*byte))
        .collect();
    let text = text.trim();
    if text.is_empty() {
        return Some(0);
    }
    usize::from_str_radix(text, 8).ok()
}

fn c_string(bytes: &[u8]) -> String {
    let end = bytes
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(bytes.len());
    String::from_utf8_lossy(&bytes[..end]).into_owned()
}

/// PAX records: `<length> <key>=<value>\n`, the length counting the whole record.
fn pax(data: &[u8]) -> Option<Vec<(String, String)>> {
    let mut records = Vec::new();
    let mut rest = data;
    while !rest.is_empty() && rest[0] != 0 {
        let space = rest.iter().position(|byte| *byte == b' ')?;
        let length: usize = std::str::from_utf8(&rest[..space]).ok()?.parse().ok()?;
        let record = rest.get(space + 1..length)?;
        let record = record.strip_suffix(b"\n")?;
        let text = std::str::from_utf8(record).ok()?;
        let (key, value) = text.split_once('=')?;
        records.push((key.to_owned(), value.to_owned()));
        rest = &rest[length..];
    }
    Some(records)
}

fn malformed_at(offset: usize, problem: &str) -> ArchiveError {
    ArchiveError::Malformed(format!("the tar header at byte {offset} {problem}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn files(entries: &[(&str, &[u8])]) -> Files {
        entries
            .iter()
            .map(|(path, bytes)| ((*path).to_owned(), bytes.to_vec()))
            .collect()
    }

    /// A raw tar entry, for archives `pack` would never write.
    pub(crate) fn raw_entry(name: &str, kind: u8, data: &[u8]) -> Vec<u8> {
        let mut header = [0u8; BLOCK];
        header[..name.len()].copy_from_slice(name.as_bytes());
        header[100..108].copy_from_slice(b"0000644\0");
        header[124..136].copy_from_slice(format!("{:011o}\0", data.len()).as_bytes());
        header[148..156].copy_from_slice(b"        ");
        header[156] = kind;
        header[257..263].copy_from_slice(b"ustar\0");
        let sum: u32 = header.iter().map(|byte| u32::from(*byte)).sum();
        header[148..156].copy_from_slice(format!("{sum:06o}\0 ").as_bytes());
        let mut entry = header.to_vec();
        entry.extend_from_slice(data);
        entry.resize(entry.len().div_ceil(BLOCK) * BLOCK, 0);
        entry
    }

    pub(crate) fn gzip(tar: &[u8]) -> Vec<u8> {
        let mut encoder = GzBuilder::new().write(Vec::new(), Compression::fast());
        encoder.write_all(tar).unwrap();
        encoder.finish().unwrap()
    }

    fn raw_archive(entries: &[Vec<u8>]) -> Vec<u8> {
        let mut tar: Vec<u8> = entries.concat();
        tar.resize(tar.len() + 2 * BLOCK, 0);
        gzip(&tar)
    }

    #[test]
    fn pack_is_deterministic_and_reads_back() {
        let input = files(&[
            ("apm.yml", b"name: x\nversion: 1.0.0\n"),
            (".apm/prompts/a.prompt.md", b"Say hello.\n"),
        ]);
        let first = pack(&input).unwrap();
        assert_eq!(first, pack(&input.clone()).unwrap());
        // gzip: no name, mtime 0, unknown OS.
        assert_eq!(&first[..10], &[0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 2, 255]);
        assert_eq!(read(&first).unwrap(), input);
    }

    #[test]
    fn long_paths_use_the_ustar_prefix() {
        let deep = format!("{}/{}", "d".repeat(120), "f".repeat(90));
        let input = files(&[(deep.as_str(), b"x")]);
        assert_eq!(read(&pack(&input).unwrap()).unwrap(), input);
        let too_long = "n".repeat(101);
        assert!(matches!(
            pack(&files(&[(too_long.as_str(), b"x")])),
            Err(ArchiveError::Unsafe(_))
        ));
    }

    #[test]
    fn pack_refuses_paths_an_extractor_would_misread() {
        for path in [
            "/etc/passwd",
            "../x",
            "a/../b",
            "a//b",
            "./a",
            "a\\b",
            "C:x",
        ] {
            assert!(
                matches!(pack(&files(&[(path, b"x")])), Err(ArchiveError::Unsafe(_))),
                "{path}"
            );
        }
    }

    #[test]
    fn read_refuses_traversal_absolute_paths_links_and_devices() {
        for (name, kind) in [
            ("../escape", b'0'),
            ("/abs", b'0'),
            ("a/../../b", b'0'),
            ("link", b'2'),
            ("hard", b'1'),
            ("dev", b'3'),
            ("fifo", b'6'),
        ] {
            let archive = raw_archive(&[raw_entry(name, kind, b"")]);
            assert!(
                matches!(read(&archive), Err(ArchiveError::Unsafe(_))),
                "{name}"
            );
        }
    }

    #[test]
    fn read_accepts_dot_slash_directories_pax_and_gnu_long_names() {
        let long = format!("{}/file.md", "x".repeat(150));
        let pax_record = {
            let body = format!("path={long}\n");
            // The length counts its own digits.
            let mut length = body.len() + 4;
            if format!("{length} {body}").len() != length {
                length += 1;
            }
            format!("{length} {body}")
        };
        let archive = raw_archive(&[
            raw_entry("./", b'5', b""),
            raw_entry("./apm.yml", b'0', b"name: x\n"),
            raw_entry("PaxHeader", b'x', pax_record.as_bytes()),
            raw_entry("truncated", b'0', b"pax"),
            raw_entry("././@LongLink", b'L', b"gnu/long/name.md\0"),
            raw_entry("trunc", b'0', b"gnu"),
        ]);
        let read = read(&archive).unwrap();
        assert_eq!(read["apm.yml"], b"name: x\n");
        assert_eq!(read[&long], b"pax");
        assert_eq!(read["gnu/long/name.md"], b"gnu");
    }

    #[test]
    fn read_refuses_a_path_twice_and_reports_corruption_as_malformed() {
        let twice = raw_archive(&[raw_entry("a", b'0', b"1"), raw_entry("./a", b'0', b"2")]);
        assert!(matches!(read(&twice), Err(ArchiveError::Unsafe(_))));
        assert!(matches!(
            read(b"PK\x03\x04zip"),
            Err(ArchiveError::Malformed(_))
        ));
        let mut corrupt = pack(&files(&[("a", b"x")])).unwrap();
        let middle = corrupt.len() / 2;
        corrupt[middle] ^= 0xff;
        assert!(matches!(read(&corrupt), Err(ArchiveError::Malformed(_))));
        let mut bad_sum = raw_entry("a", b'0', b"x");
        bad_sum[0] = b'b';
        assert!(matches!(
            read(&raw_archive(&[bad_sum])),
            Err(ArchiveError::Malformed(_))
        ));
    }
}
