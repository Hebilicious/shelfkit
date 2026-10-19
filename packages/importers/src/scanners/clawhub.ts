/**
 * ClawHub's verdict on a skill version, for items imported from ClawHub.
 *
 * ClawHub publishes, beside each version's verdict, the sha256 of every file it holds. The verdict is taken only when
 * the files of the revision being scanned are exactly those files, byte for byte; it is then recorded against
 * ShelfKit's revision hash, never ClawHub's timestamp. A revision whose files differ gets an `error` saying so, and an
 * item ClawHub has not scanned, or that did not come from ClawHub, gets no verdict at all.
 */
import {
  clawHubRef,
  listingUrl,
  VersionSchema,
  versionUrl,
} from "../adapters/clawhub.ts";
import { fileBytes, getJson, sha256Hex } from "../http.ts";
import type {
  AdapterContext,
  ImportedFile,
  ScanSubject,
  ScanVerdict,
  Scanner,
} from "../seam.ts";

export const CLAWHUB_SCANNER_ID = "clawhub";

/** ClawHub's definitive statuses, as verdicts; anything else (pending, an error) is no verdict yet. */
const VERDICTS = new Map<string, ScanVerdict["verdict"]>([
  ["clean", "clean"],
  ["malicious", "malicious"],
  ["suspicious", "suspicious"],
]);

/** Whether `files` are exactly the files ClawHub lists, by path and sha256. */
async function sameFiles(
  files: readonly ImportedFile[],
  listed: readonly { path: string; sha256: string }[]
): Promise<boolean> {
  const expected = new Map(
    listed.map((file) => [file.path, file.sha256.toLowerCase()])
  );
  const hashes = await Promise.all(
    files.map(async (file) => ({
      digest: await sha256Hex(fileBytes(file)),
      path: file.path,
    }))
  );
  return (
    hashes.length === expected.size &&
    hashes.every(({ digest, path }) => expected.get(path) === digest)
  );
}

async function scan(
  subject: ScanSubject,
  context: AdapterContext
): Promise<ScanVerdict | null> {
  const ref = clawHubRef(subject.item);
  const version = subject.item.source?.version;
  // A link-only item holds no content of ClawHub's to vouch for.
  const ours = subject.files.filter((file) => file.path !== "item.json");
  if (ref === undefined || version === undefined || ours.length === 0) {
    return null;
  }
  const found = await getJson(
    context.fetch,
    versionUrl(ref.owner, ref.slug, version),
    VersionSchema
  );
  const security = found?.version.security ?? undefined;
  const verdict =
    security?.status === undefined ? undefined : VERDICTS.get(security.status);
  if (
    found === null ||
    security === undefined ||
    security.hasScanResult !== true ||
    verdict === undefined
  ) {
    return null;
  }
  const detailsUrl = `${listingUrl(ref.owner, ref.slug)}/security-audit?version=${encodeURIComponent(version)}`;
  const bundle = security.sha256hash ?? undefined;
  const observed =
    bundle === undefined
      ? `${ref.owner}/${ref.slug}@${version}`
      : `sha256:${bundle.toLowerCase()} (ClawHub's bundle digest of ${ref.owner}/${ref.slug}@${version})`;
  const status = security.status ?? "";
  if (!(await sameFiles(ours, found.version.files))) {
    return {
      detailsUrl,
      observed,
      scanner: CLAWHUB_SCANNER_ID,
      summary: `ClawHub's verdict (${status}) is for files that differ from this revision's, so it is not taken`,
      verdict: "error",
    };
  }
  return {
    detailsUrl,
    observed,
    scanner: CLAWHUB_SCANNER_ID,
    summary: `ClawHub: ${status}; every file of this revision matches the sha256 ClawHub lists for ${version}`,
    verdict,
  };
}

export const clawHubScanner: Scanner = { id: CLAWHUB_SCANNER_ID, scan };
