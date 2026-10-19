/**
 * ClawHub's verdict on a skill version, for items imported from ClawHub.
 *
 * ClawHub publishes, beside each version's verdict, the sha256 of every file it holds. The verdict is taken only when
 * the files of the revision being scanned are exactly those files, byte for byte; it is then recorded against
 * ShelfKit's revision hash, never ClawHub's timestamp. A revision whose files differ gets an `error` saying so, and an
 * item ClawHub has not scanned, or that did not come from ClawHub, gets no verdict at all.
 */
import * as v from "valibot";

import {
  clawHubRef,
  listingUrl,
  VersionSchema,
  versionUrl,
} from "../adapters/clawhub.ts";
import { fileBytes, getJson, sha256Hex } from "../http.ts";
import type {
  AdapterContext,
  ScanSubject,
  ScanVerdict,
  Scanner,
} from "../seam.ts";

export const CLAWHUB_SCANNER_ID = "clawhub";

const VERDICTS: Readonly<Record<string, ScanVerdict["verdict"]>> = {
  clean: "clean",
  malicious: "malicious",
  suspicious: "suspicious",
};

async function scan(
  subject: ScanSubject,
  context: AdapterContext
): Promise<ScanVerdict | null> {
  const ref = clawHubRef(subject.item);
  const version = subject.item.source?.version;
  if (ref === undefined || version === undefined) {
    return null;
  }
  const ours = subject.files.filter((file) => file.path !== "item.json");
  if (ours.length === 0) {
    // A link-only item holds no content of ClawHub's to vouch for.
    return null;
  }
  const found = await getJson(
    context.fetch,
    versionUrl(ref.owner, ref.slug, version)
  );
  if (found === null) {
    return null;
  }
  const published = v.parse(VersionSchema, found).version;
  const security = published.security;
  const verdict =
    security?.status === undefined ? undefined : VERDICTS[security.status];
  if (
    security === undefined ||
    security === null ||
    security.hasScanResult !== true ||
    verdict === undefined
  ) {
    return null;
  }
  const detailsUrl = `${listingUrl(ref.owner, ref.slug)}/security-audit?version=${encodeURIComponent(version)}`;
  const listed = new Map(
    published.files.map((file) => [file.path, file.sha256.toLowerCase()])
  );
  const hashes = await Promise.all(
    ours.map(
      async (file) => [file.path, await sha256Hex(fileBytes(file))] as const
    )
  );
  const differs =
    hashes.length !== listed.size ||
    hashes.some(([path, digest]) => listed.get(path) !== digest);
  const observed =
    security.sha256hash === undefined || security.sha256hash === null
      ? `${ref.owner}/${ref.slug}@${version}`
      : `sha256:${security.sha256hash.toLowerCase()} (ClawHub's bundle digest of ${ref.owner}/${ref.slug}@${version})`;
  if (differs) {
    return {
      detailsUrl,
      observed,
      scanner: CLAWHUB_SCANNER_ID,
      summary: `ClawHub's verdict (${security.status}) is for files that differ from this revision's, so it is not taken`,
      verdict: "error",
    };
  }
  return {
    detailsUrl,
    observed,
    scanner: CLAWHUB_SCANNER_ID,
    summary: `ClawHub: ${security.status}; every file of this revision matches the sha256 ClawHub lists for ${version}`,
    verdict,
  };
}

export const clawHubScanner: Scanner = { id: CLAWHUB_SCANNER_ID, scan };
