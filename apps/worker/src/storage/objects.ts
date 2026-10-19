/**
 * Content in R2, keyed by its SHA-256, and no database holds a blob. File bytes and snapshot manifests are
 * `objects/<lowercase hex>`; published registry archives are `archives/<lowercase hex>`, the one prefix under the R2
 * bucket lock (`scripts/setup.ts`), so a published version cannot be overwritten or deleted. Every write is
 * put-if-absent: a second write of the same bytes is a no-op.
 */

/** The prefix a shelf's content lives under: file bytes and snapshot manifests, by sha256. Not locked. */
export const OBJECTS_PREFIX = "objects/";

/**
 * The prefix published registry archives live under, by sha256. The bucket lock retains it indefinitely, so a
 * published version cannot be overwritten or deleted at the storage layer either.
 */
export const ARCHIVES_PREFIX = "archives/";

export function objectKey(sha256: string): string {
  return `${OBJECTS_PREFIX}${sha256}`;
}

export function archiveKey(sha256: string): string {
  return `${ARCHIVES_PREFIX}${sha256}`;
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
  contentType = "application/octet-stream",
  keyOf: (sha256: string) => string = objectKey
): Promise<string> {
  const hash = await sha256Hex(bytes);
  const key = keyOf(hash);
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
