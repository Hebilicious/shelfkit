//! Standard base64 with padding, for vendored files that are not UTF-8 text.
//! Small enough to keep a dependency out of the WASM engine.

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            chunk.get(1).copied().unwrap_or(0),
            chunk.get(2).copied().unwrap_or(0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for (index, shift) in [18, 12, 6, 0].into_iter().enumerate() {
            if index <= chunk.len() {
                out.push(char::from(ALPHABET[((n >> shift) & 63) as usize]));
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// `None` for anything that is not padded standard base64.
pub fn decode(text: &str) -> Option<Vec<u8>> {
    let bytes = text.as_bytes();
    if !bytes.len().is_multiple_of(4) {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    for (index, chunk) in bytes.chunks(4).enumerate() {
        let last = index == bytes.len() / 4 - 1;
        let padding = chunk.iter().rev().take_while(|&&b| b == b'=').count();
        if padding > 2 || (padding > 0 && !last) {
            return None;
        }
        let mut n = 0u32;
        for &byte in &chunk[..4 - padding] {
            let value = ALPHABET.iter().position(|&a| a == byte)?;
            n = (n << 6) | value as u32;
        }
        n <<= 6 * padding as u32;
        let decoded = [(n >> 16) as u8, (n >> 8) as u8, n as u8];
        out.extend_from_slice(&decoded[..3 - padding]);
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_every_length() {
        let data: Vec<u8> = (0..=255).collect();
        for len in 0..10 {
            let encoded = encode(&data[..len]);
            assert_eq!(decode(&encoded).as_deref(), Some(&data[..len]), "{encoded}");
        }
        assert_eq!(encode(b"Man"), "TWFu");
        assert_eq!(encode(b"Ma"), "TWE=");
        assert_eq!(decode("TQ=="), Some(b"M".to_vec()));
        assert_eq!(decode("TQ="), None);
        assert_eq!(decode("T=Q="), None);
        assert_eq!(decode("TQ==TWFu"), None);
    }
}
