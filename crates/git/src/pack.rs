//! Pack files, version 2: writing one of whole objects, and reading any,
//! deltas included.

use crate::object::{Kind, ObjectId, object_id};
use crate::{Error, Result};
use flate2::write::ZlibEncoder;
use flate2::{Compression, Decompress, FlushDecompress, Status};
use sha1::{Digest, Sha1};
use std::collections::HashMap;
use std::io::Write;

/// An object read from a pack.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackObject {
    pub kind: Kind,
    pub id: ObjectId,
    pub body: Vec<u8>,
}

/// A pack entry's type number for a delta against an earlier entry.
const OFS_DELTA: u8 = 6;
/// A pack entry's type number for a delta against an object named by id.
const REF_DELTA: u8 = 7;
/// The length of the trailing SHA-1.
const CHECKSUM: usize = 20;
/// The most a single step of inflating grows its output by.
const INFLATE_CHUNK: usize = 1 << 20;

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

/// An entry as stored, before its delta is applied.
enum Stored {
    Whole(Kind, Vec<u8>),
    /// A delta against the entry at this index.
    AgainstEntry(usize, Vec<u8>),
    /// A delta against the object with this id.
    AgainstId(ObjectId, Vec<u8>),
}

/// Every object in a version 2 (or 3) pack, in the order the pack stores
/// them, with each delta applied. The trailing checksum is verified, and a
/// delta whose base is not in the pack is an error naming the base.
pub fn read(pack: &[u8]) -> Result<Vec<PackObject>> {
    if pack.len() < 12 + CHECKSUM || !pack.starts_with(b"PACK") {
        return Err(Error::malformed("pack", "no `PACK` header"));
    }
    let (data, checksum) = pack.split_at(pack.len() - CHECKSUM);
    if Sha1::digest(data).as_slice() != checksum {
        return Err(Error::malformed(
            "pack",
            "the trailing checksum does not match its contents",
        ));
    }
    let version = u32::from_be_bytes([data[4], data[5], data[6], data[7]]);
    if version != 2 && version != 3 {
        return Err(Error::malformed(
            "pack",
            format!("version {version} is not supported"),
        ));
    }
    let count = u32::from_be_bytes([data[8], data[9], data[10], data[11]]) as usize;

    let mut stored = Vec::new();
    let mut index_at_offset = HashMap::new();
    let mut position = 12;
    for _ in 0..count {
        let start = position;
        let what = || format!("pack entry at offset {start}");
        let (pack_type, size) = read_entry_header(data, &mut position)
            .ok_or_else(|| Error::malformed(what(), "the type and size are cut short"))?;
        let entry = match pack_type {
            OFS_DELTA => {
                let distance = read_offset(data, &mut position)
                    .ok_or_else(|| Error::malformed(what(), "the base's offset is cut short"))?;
                let base = start
                    .checked_sub(distance)
                    .filter(|_| distance > 0)
                    .and_then(|offset| index_at_offset.get(&offset).copied())
                    .ok_or_else(|| {
                        Error::malformed(what(), "the delta's base is not an earlier entry")
                    })?;
                Stored::AgainstEntry(base, inflate(data, &mut position, size, &what)?)
            }
            REF_DELTA => {
                let base = data
                    .get(position..position + 20)
                    .and_then(ObjectId::from_slice)
                    .ok_or_else(|| Error::malformed(what(), "the base's id is cut short"))?;
                position += 20;
                Stored::AgainstId(base, inflate(data, &mut position, size, &what)?)
            }
            number => {
                let kind = Kind::from_pack_type(number).ok_or_else(|| {
                    Error::malformed(what(), format!("unknown entry type {number}"))
                })?;
                Stored::Whole(kind, inflate(data, &mut position, size, &what)?)
            }
        };
        index_at_offset.insert(start, stored.len());
        stored.push((start, entry));
    }
    if position != data.len() {
        return Err(Error::malformed(
            "pack",
            format!("{} bytes follow the last entry", data.len() - position),
        ));
    }
    resolve(&stored)
}

/// Apply every delta. An entry against an earlier one resolves in the first
/// pass; one against an id may need later passes, as its base may be a delta
/// itself, or come later in the pack.
fn resolve(stored: &[(usize, Stored)]) -> Result<Vec<PackObject>> {
    let mut resolved: Vec<Option<PackObject>> = vec![None; stored.len()];
    let mut index_of_id: HashMap<ObjectId, usize> = HashMap::new();
    let mut progress = true;
    while progress {
        progress = false;
        for (index, (offset, entry)) in stored.iter().enumerate() {
            if resolved[index].is_some() {
                continue;
            }
            let object = match entry {
                Stored::Whole(kind, body) => whole(*kind, body.clone()),
                Stored::AgainstEntry(base, delta) => match &resolved[*base] {
                    Some(base) => apply(base, delta, *offset)?,
                    None => continue,
                },
                Stored::AgainstId(id, delta) => {
                    match index_of_id
                        .get(id)
                        .and_then(|base| resolved[*base].as_ref())
                    {
                        Some(base) => apply(base, delta, *offset)?,
                        None => continue,
                    }
                }
            };
            index_of_id.insert(object.id, index);
            resolved[index] = Some(object);
            progress = true;
        }
    }
    let mut objects = Vec::with_capacity(stored.len());
    for ((offset, entry), object) in stored.iter().zip(resolved) {
        match object {
            Some(object) => objects.push(object),
            None => {
                let what = format!("pack entry at offset {offset}");
                return Err(match entry {
                    Stored::AgainstId(id, _) if !index_of_id.contains_key(id) => {
                        Error::malformed(what, format!("the delta's base {id} is not in the pack"))
                    }
                    _ => Error::malformed(what, "the delta's base cannot be resolved"),
                });
            }
        }
    }
    Ok(objects)
}

fn whole(kind: Kind, body: Vec<u8>) -> PackObject {
    PackObject {
        kind,
        id: object_id(kind, &body),
        body,
    }
}

fn apply(base: &PackObject, delta: &[u8], offset: usize) -> Result<PackObject> {
    let body = apply_delta(&base.body, delta).map_err(|reason| {
        Error::malformed(
            format!("pack entry at offset {offset}"),
            format!("the delta against {} is invalid: {reason}", base.id),
        )
    })?;
    Ok(whole(base.kind, body))
}

/// The object a delta describes: the sizes of its base and its result, then
/// instructions that copy a range of the base or insert literal bytes.
fn apply_delta(base: &[u8], delta: &[u8]) -> Result<Vec<u8>, String> {
    let mut position = 0;
    let mut size = || read_size(delta, &mut position).ok_or("a size is cut short");
    let base_size = size()?;
    let result_size = size()?;
    if base_size != base.len() as u64 {
        return Err(format!(
            "it expects a {base_size}-byte base, and the base has {} bytes",
            base.len()
        ));
    }
    let result_size = usize::try_from(result_size).map_err(|_| "the result is too large")?;
    let mut result = Vec::with_capacity(result_size.min(INFLATE_CHUNK));
    while let Some(&instruction) = delta.get(position) {
        position += 1;
        if instruction & 0x80 != 0 {
            let mut field = |bit: u8, shift: u32| -> Result<usize, String> {
                if instruction & bit == 0 {
                    return Ok(0);
                }
                let byte = *delta.get(position).ok_or("a copy is cut short")?;
                position += 1;
                Ok(usize::from(byte) << shift)
            };
            let start = field(0x01, 0)? | field(0x02, 8)? | field(0x04, 16)? | field(0x08, 24)?;
            let length = match field(0x10, 0)? | field(0x20, 8)? | field(0x40, 16)? {
                0 => 0x10000,
                length => length,
            };
            let copied = start
                .checked_add(length)
                .and_then(|end| base.get(start..end))
                .ok_or("a copy reaches past the end of the base")?;
            result.extend_from_slice(copied);
        } else if instruction != 0 {
            let length = usize::from(instruction);
            let inserted = delta
                .get(position..position + length)
                .ok_or("an insert is cut short")?;
            position += length;
            result.extend_from_slice(inserted);
        } else {
            return Err("instruction 0 is reserved".to_owned());
        }
        if result.len() > result_size {
            return Err(format!("it builds more than its {result_size} bytes"));
        }
    }
    if result.len() != result_size {
        return Err(format!(
            "it builds {} bytes, not its {result_size}",
            result.len()
        ));
    }
    Ok(result)
}

/// A delta's size: seven bits per byte, least significant first.
fn read_size(bytes: &[u8], position: &mut usize) -> Option<u64> {
    let mut size = 0u64;
    let mut shift = 0;
    loop {
        let byte = *bytes.get(*position)?;
        *position += 1;
        if shift > 63 {
            return None;
        }
        size |= u64::from(byte & 0x7f) << shift;
        shift += 7;
        if byte & 0x80 == 0 {
            return Some(size);
        }
    }
}

fn read_entry_header(data: &[u8], position: &mut usize) -> Option<(u8, usize)> {
    let mut byte = *data.get(*position)?;
    *position += 1;
    let pack_type = (byte >> 4) & 0x07;
    let mut size = u64::from(byte & 0x0f);
    let mut shift = 4;
    while byte & 0x80 != 0 {
        byte = *data.get(*position)?;
        *position += 1;
        if shift > 63 {
            return None;
        }
        size |= u64::from(byte & 0x7f) << shift;
        shift += 7;
    }
    Some((pack_type, usize::try_from(size).ok()?))
}

/// An `OFS_DELTA` entry's distance back to its base: seven bits per byte,
/// most significant first, each continuation adding one.
fn read_offset(data: &[u8], position: &mut usize) -> Option<usize> {
    let mut byte = *data.get(*position)?;
    *position += 1;
    let mut distance = usize::from(byte & 0x7f);
    while byte & 0x80 != 0 {
        byte = *data.get(*position)?;
        *position += 1;
        distance = distance
            .checked_add(1)?
            .checked_mul(128)?
            .checked_add(usize::from(byte & 0x7f))?;
    }
    Some(distance)
}

/// Inflate the zlib stream at `position`, which must hold exactly `size`
/// bytes, and move `position` past it.
fn inflate(
    data: &[u8],
    position: &mut usize,
    size: usize,
    what: &dyn Fn() -> String,
) -> Result<Vec<u8>> {
    let input = &data[*position..];
    let mut decompress = Decompress::new(true);
    let mut output = Vec::with_capacity(size.min(INFLATE_CHUNK));
    loop {
        if output.len() == output.capacity() {
            // Room for the rest, or for one byte past it, to catch a stream
            // that inflates to more than it says.
            output.reserve((size - output.len().min(size)).clamp(1, INFLATE_CHUNK));
        }
        let consumed = decompress.total_in() as usize;
        let produced = decompress.total_out();
        let status = decompress
            .decompress_vec(&input[consumed..], &mut output, FlushDecompress::None)
            .map_err(|error| Error::malformed(what(), format!("not a zlib stream: {error}")))?;
        if output.len() > size {
            return Err(Error::malformed(
                what(),
                format!("it inflates to more than its {size} bytes"),
            ));
        }
        match status {
            Status::StreamEnd => break,
            Status::Ok | Status::BufError => {
                if decompress.total_in() as usize == consumed && decompress.total_out() == produced
                {
                    return Err(Error::malformed(what(), "the zlib stream is cut short"));
                }
            }
        }
    }
    if output.len() != size {
        return Err(Error::malformed(
            what(),
            format!("it inflates to {} bytes, not its {size}", output.len()),
        ));
    }
    *position += decompress.total_in() as usize;
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_what_it_writes() {
        let big = vec![b'x'; 70_000];
        let objects: Vec<(Kind, &[u8])> = vec![
            (Kind::Blob, b"hello\n"),
            (Kind::Blob, b""),
            (Kind::Tree, b""),
            (Kind::Blob, &big),
        ];
        let pack = write(&objects).unwrap();
        let read = read(&pack).unwrap();
        assert_eq!(read.len(), 4);
        for ((kind, body), object) in objects.iter().zip(&read) {
            assert_eq!(object.kind, *kind);
            assert_eq!(object.body, *body);
            assert_eq!(object.id, object_id(*kind, body));
        }
    }

    #[test]
    fn refuses_a_bad_checksum_and_trailing_bytes() {
        let mut pack = write(&[(Kind::Blob, b"hello\n")]).unwrap();
        let last = pack.len() - 1;
        pack[last] ^= 1;
        assert!(read(&pack).unwrap_err().reason().contains("checksum"));
        assert!(read(b"PACK").is_err());
    }

    /// A pack of the given entries, each `(type, prefix, body)`, with a
    /// correct checksum. An `OFS_DELTA` entry is against the entry before it.
    fn raw_pack(entries: &[(u8, Vec<u8>, &[u8])]) -> Vec<u8> {
        let mut pack = b"PACK".to_vec();
        pack.extend_from_slice(&2u32.to_be_bytes());
        pack.extend_from_slice(&(entries.len() as u32).to_be_bytes());
        let mut previous = 0;
        for (pack_type, prefix, body) in entries {
            let start = pack.len();
            write_entry_header(&mut pack, *pack_type, body.len());
            if *pack_type == OFS_DELTA {
                let distance = start - previous;
                assert!(distance < 128, "the test encodes one byte");
                pack.push(distance as u8);
            }
            previous = start;
            pack.extend_from_slice(prefix);
            let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
            encoder.write_all(body).unwrap();
            pack.extend_from_slice(&encoder.finish().unwrap());
        }
        let checksum = Sha1::digest(&pack);
        pack.extend_from_slice(&checksum);
        pack
    }

    #[test]
    fn applies_ref_deltas_in_any_order_and_names_a_missing_base() {
        let base = b"hello world\n";
        let base_id = object_id(Kind::Blob, base);
        // Copy "hello " from the base, then insert "there\n".
        let mut delta = vec![12, 12, 0x90, 6, 6];
        delta.extend_from_slice(b"there\n");
        let pack = raw_pack(&[
            (REF_DELTA, base_id.0.to_vec(), &delta),
            (3, Vec::new(), base),
        ]);
        let objects = read(&pack).unwrap();
        assert_eq!(objects[0].body, b"hello there\n");
        assert_eq!(objects[0].kind, Kind::Blob);
        assert_eq!(objects[0].id, object_id(Kind::Blob, b"hello there\n"));

        let pack = raw_pack(&[(REF_DELTA, base_id.0.to_vec(), &delta)]);
        let error = read(&pack).unwrap_err();
        assert!(error.reason().contains(&base_id.to_string()), "{error}");
    }

    #[test]
    fn refuses_a_delta_that_does_not_fit_its_base() {
        let base = b"short";
        // Copy ten bytes from a five-byte base.
        let delta = [5, 10, 0x90, 10];
        let pack = raw_pack(&[(3, Vec::new(), base), (OFS_DELTA, Vec::new(), &delta)]);
        assert!(read(&pack).unwrap_err().reason().contains("invalid"));
        // Copy the base, then insert two bytes.
        let delta = [5, 7, 0x90, 5, 2, b'e', b'r'];
        let pack = raw_pack(&[(3, Vec::new(), base), (OFS_DELTA, Vec::new(), &delta)]);
        assert_eq!(read(&pack).unwrap()[1].body, b"shorter");
    }
}
