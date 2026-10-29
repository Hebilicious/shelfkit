//! Pack files, version 2, as a push sends them: whole objects, each
//! compressed, and no deltas. Reading one is the server's business: the
//! real `git` reads these in the tests (`tests/real_git.rs`).

use crate::object::Kind;
use crate::{Error, Result};
use flate2::Compression;
use flate2::write::ZlibEncoder;
use sha1::{Digest, Sha1};
use std::io::Write;

/// A version 2 pack of `objects`, each stored whole and compressed, in the
/// order given, followed by the SHA-1 of everything before it.
pub fn write<B: AsRef<[u8]>>(objects: &[(Kind, B)]) -> Result<Vec<u8>> {
    let count = u32::try_from(objects.len())
        .map_err(|_| Error::malformed("pack", "more objects than a pack can count"))?;
    let mut pack = Vec::new();
    pack.extend_from_slice(b"PACK");
    pack.extend_from_slice(&2u32.to_be_bytes());
    pack.extend_from_slice(&count.to_be_bytes());
    for (kind, body) in objects {
        let body = body.as_ref();
        write_entry_header(&mut pack, kind.pack_type(), body.len());
        let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
        let compressed = encoder
            .write_all(body)
            .and_then(|()| encoder.finish())
            .map_err(|error| Error::malformed("pack", format!("compression failed: {error}")))?;
        pack.extend_from_slice(&compressed);
    }
    let checksum = Sha1::digest(&pack);
    pack.extend_from_slice(&checksum);
    Ok(pack)
}

/// The type and size of an entry: three bits of type and four of size in the
/// first byte, then seven bits of size per byte, each byte but the last with
/// its high bit set.
fn write_entry_header(pack: &mut Vec<u8>, pack_type: u8, size: usize) {
    let mut size = size as u64;
    let mut byte = (pack_type << 4) | (size & 0x0f) as u8;
    size >>= 4;
    while size > 0 {
        pack.push(byte | 0x80);
        byte = (size & 0x7f) as u8;
        size >>= 7;
    }
    pack.push(byte);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entry_headers_carry_the_type_and_the_size() {
        let mut header = Vec::new();
        write_entry_header(&mut header, Kind::Blob.pack_type(), 6);
        assert_eq!(header, [0x36]);
        header.clear();
        // 70000 is 0x11170: four bits in the first byte, then seven at a time.
        write_entry_header(&mut header, Kind::Tree.pack_type(), 70_000);
        assert_eq!(header, [0xa0, 0x97, 0x22]);
    }

    #[test]
    fn a_pack_counts_its_objects_and_ends_with_its_checksum() {
        let pack = write(&[(Kind::Blob, &b"hello\n"[..]), (Kind::Tree, &b""[..])]).unwrap();
        assert_eq!(&pack[..12], b"PACK\0\0\0\x02\0\0\0\x02");
        let (data, checksum) = pack.split_at(pack.len() - 20);
        assert_eq!(Sha1::digest(data).as_slice(), checksum);
        assert_eq!(data[12], 0x36);
    }
}
