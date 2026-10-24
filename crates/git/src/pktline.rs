//! pkt-lines: four hex digits of length (the four included), then the data.
//! `0000` is a flush, and `0001` a delimiter.

use crate::{Error, Result};

/// The flush packet, which ends a section.
pub const FLUSH: &[u8] = b"0000";
/// The delimiter packet, which separates sections in protocol v2.
pub const DELIM: &[u8] = b"0001";
/// The most data one packet carries: 65520 bytes, less the length.
pub const MAX_DATA: usize = 65_516;

/// One packet read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Packet<'a> {
    Data(&'a [u8]),
    Flush,
    Delim,
}

/// Append a data packet carrying `data` to `out`.
pub fn write(out: &mut Vec<u8>, data: &[u8]) -> Result<()> {
    if data.len() > MAX_DATA {
        return Err(Error::malformed(
            "pkt-line",
            format!("{} bytes is more than a packet carries", data.len()),
        ));
    }
    out.extend_from_slice(format!("{:04x}", data.len() + 4).as_bytes());
    out.extend_from_slice(data);
    Ok(())
}

/// Reads packets from the front of a byte string, leaving whatever follows
/// (a pack, after a request's flush) to [`Reader::rest`].
#[derive(Debug, Clone)]
pub struct Reader<'a> {
    bytes: &'a [u8],
    position: usize,
}

impl<'a> Reader<'a> {
    pub fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, position: 0 }
    }

    /// The next packet, or `None` at the end of the bytes.
    pub fn next_packet(&mut self) -> Result<Option<Packet<'a>>> {
        let rest = self.rest();
        if rest.is_empty() {
            return Ok(None);
        }
        let what = || format!("pkt-line at offset {}", self.position);
        let length = rest
            .get(..4)
            .and_then(|digits| std::str::from_utf8(digits).ok())
            .filter(|digits| digits.bytes().all(|byte| byte.is_ascii_hexdigit()))
            .and_then(|digits| usize::from_str_radix(digits, 16).ok())
            .ok_or_else(|| Error::malformed(what(), "the length is not four hex digits"))?;
        let packet = match length {
            0 => Packet::Flush,
            1 => Packet::Delim,
            2 | 3 => {
                return Err(Error::malformed(
                    what(),
                    format!("packet {length:04x} is not supported"),
                ));
            }
            _ => Packet::Data(rest.get(4..length).ok_or_else(|| {
                Error::malformed(
                    what(),
                    format!("it says {length} bytes, and {} remain", rest.len()),
                )
            })?),
        };
        self.position += length.max(4);
        Ok(Some(packet))
    }

    /// The bytes not read yet.
    pub fn rest(&self) -> &'a [u8] {
        &self.bytes[self.position..]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips() {
        let mut out = Vec::new();
        write(&mut out, b"hello\n").unwrap();
        out.extend_from_slice(DELIM);
        write(&mut out, b"").unwrap();
        out.extend_from_slice(FLUSH);
        out.extend_from_slice(b"PACK");
        assert_eq!(out, b"000ahello\n000100040000PACK");
        let mut reader = Reader::new(&out);
        assert_eq!(
            reader.next_packet().unwrap(),
            Some(Packet::Data(b"hello\n"))
        );
        assert_eq!(reader.next_packet().unwrap(), Some(Packet::Delim));
        assert_eq!(reader.next_packet().unwrap(), Some(Packet::Data(b"")));
        assert_eq!(reader.next_packet().unwrap(), Some(Packet::Flush));
        assert_eq!(reader.rest(), b"PACK");
    }

    #[test]
    fn refuses_what_is_not_a_packet() {
        assert!(Reader::new(b"00zz").next_packet().is_err());
        assert!(Reader::new(b"0010abc").next_packet().is_err());
        assert!(Reader::new(b"0002").next_packet().is_err());
        assert!(Reader::new(b"+00a").next_packet().is_err());
        let mut reader = Reader::new(b"");
        assert_eq!(reader.next_packet().unwrap(), None);
        let mut out = Vec::new();
        assert!(write(&mut out, &vec![0; MAX_DATA + 1]).is_err());
        assert!(write(&mut out, &vec![0; MAX_DATA]).is_ok());
        assert_eq!(&out[..4], b"fff0");
    }
}
