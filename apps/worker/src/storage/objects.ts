/**
 * Content in R2, keyed by its SHA-256: `objects/<lowercase hex>`. File bytes, snapshot manifests, and registry
 * archives all live here, and no database holds a blob. The prefix is under an R2 bucket lock (`scripts/setup.ts`), so
 * an object, once written, cannot be overwritten or deleted: a write is put-if-absent, and a second write of the same
 * bytes is a no-op.
 */

/** The prefix every content-addressed object lives under, and the one the bucket lock covers. */
export const OBJECTS_PREFIX = "objects/";

export function objectKey(sha256: string): string {
  return `${OBJECTS_PREFIX}${sha256}`;
}

/** Lowercase hex SHA-256 of `bytes`. */
export async function sha256Hex(bytes: Uint8Array | string): Promise<string> {
  const data =
    bytes instanceof Uint8Array
      ? new Uint8Array(bytes)
      : new TextEncoder().encode(bytes);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return [...hash].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A lowercase hex SHA-256. */
export function isSha256Hex(text: string): boolean {
  return /^[0-9a-f]{64}$/u.test(text);
}

/**
 * Store `bytes` under their hash unless an object is already there. Returns the hash. A put that loses a race to the
 * same key is refused by the bucket lock; the bytes are the same, so that is success.
 */
export async function putObject(
  bucket: R2Bucket,
  bytes: Uint8Array,
  contentType = "application/octet-stream"
): Promise<string> {
  const hash = await sha256Hex(bytes);
  const key = objectKey(hash);
  if ((await bucket.head(key)) !== null) {
    return hash;
  }
  try {
    await bucket.put(key, bytes, {
      httpMetadata: { contentType },
      sha256: hash,
    });
  } catch (error) {
    if ((await bucket.head(key)) === null) {
      throw error;
    }
  }
  return hash;
}

/** The bytes of an object, or `null` when R2 has none under that hash. */
export async function readObject(
  bucket: R2Bucket,
  sha256: string
): Promise<Uint8Array | null> {
  const found = await bucket.get(objectKey(sha256));
  return found === null ? null : new Uint8Array(await found.arrayBuffer());
}

/** Read many objects at once, a bounded number in flight. Throws when one is missing. */
export async function readObjects(
  bucket: R2Bucket,
  hashes: readonly string[],
  concurrency = 16
): Promise<Map<string, Uint8Array>> {
  const unique = [...new Set(hashes)];
  const found = new Map<string, Uint8Array>();
  const queue = [...unique];
  const worker = async (): Promise<void> => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- each worker reads one object at a time; `concurrency` workers run at once.
      const bytes = await readObject(bucket, next);
      if (bytes === null) {
        throw new Error(`R2 has no object ${objectKey(next)}`);
      }
      found.set(next, bytes);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, unique.length) }, worker)
  );
  return found;
}
