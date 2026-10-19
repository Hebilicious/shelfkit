/**
 * The skills.sh audits (https://skills.sh/docs/api): verdicts from the security partners skills.sh lists, for skills
 * in GitHub repositories. Each partner is its own scanner, so partners that disagree are each recorded and all shown.
 *
 * skills.sh publishes a provider, a status, and a timestamp, but no hash of what was audited. The verdict is recorded
 * against the revision ShelfKit computed at the time it asked, never against that timestamp, so a new revision starts
 * unscanned and asks again; the timestamp is kept only as what the provider says it observed. A skill skills.sh does
 * not list, or a partner that has not audited it, gives no verdict.
 */
import * as v from "valibot";

import { parseRepository } from "../github.ts";
import { getJson } from "../http.ts";
import type {
  AdapterContext,
  Item,
  ScanSubject,
  ScanVerdict,
  Scanner,
} from "../seam.ts";

export const SKILLS_SH = "https://skills.sh";

const AuditSchema = v.object({
  audits: v.array(
    v.object({
      auditedAt: v.optional(v.string()),
      provider: v.string(),
      riskLevel: v.optional(v.string()),
      slug: v.string(),
      status: v.string(),
      summary: v.optional(v.string()),
    })
  ),
});

/** The partners skills.sh lists, by its slug for each. */
export const SKILLS_SH_PARTNERS: readonly string[] = [
  "agent-trust-hub",
  "socket",
  "snyk",
  "runlayer",
  "zeroleaks",
];

/** A provider's status as a verdict; an unknown status is no verdict, never a guess. */
function verdictOf(status: string): ScanVerdict["verdict"] | undefined {
  const normalized = status.toLowerCase();
  if (["pass", "passed", "safe", "clean"].includes(normalized)) {
    return "clean";
  }
  if (
    ["warn", "warning", "review", "suspicious", "medium"].includes(normalized)
  ) {
    return "suspicious";
  }
  if (
    ["fail", "failed", "malicious", "critical", "high", "danger"].includes(
      normalized
    )
  ) {
    return "malicious";
  }
  if (normalized === "error") {
    return "error";
  }
  return undefined;
}

/** The skills.sh id of a skill imported from GitHub: `owner/repo/skill`. */
export function skillsShId(item: Item): string | undefined {
  const { source } = item;
  if (item.kind !== "skill" || source?.repo === undefined) {
    return undefined;
  }
  try {
    const repository = parseRepository(source.repo);
    const skill = source.path?.split("/").at(-1) ?? repository.name;
    return `${repository.owner}/${repository.name}/${skill}`;
  } catch {
    return undefined;
  }
}

function partnerScanner(partner: string): Scanner {
  const id = `skills.sh/${partner}`;
  return {
    id,
    scan: async (
      subject: ScanSubject,
      context: AdapterContext
    ): Promise<ScanVerdict | null> => {
      const skill = skillsShId(subject.item);
      if (skill === undefined) {
        return null;
      }
      const found = await getJson(
        context.fetch,
        `${SKILLS_SH}/api/v1/skills/audit/${skill}`,
        AuditSchema
      );
      const audit = found?.audits.find((entry) => entry.slug === partner);
      const verdict = audit === undefined ? undefined : verdictOf(audit.status);
      if (audit === undefined || verdict === undefined) {
        return null;
      }
      const when =
        audit.auditedAt === undefined ? "" : ` at ${audit.auditedAt}`;
      return {
        detailsUrl: `${SKILLS_SH}/${skill}`,
        observed: `${audit.provider} audited ${skill}${when}; skills.sh publishes no hash of what it audited`,
        scanner: id,
        summary: [
          `${audit.provider}: ${audit.status}`,
          audit.riskLevel,
          audit.summary,
        ]
          .filter((part) => part !== undefined && part !== "")
          .join(" \u00B7 "),
        verdict,
      };
    },
  };
}

export const skillsShScanners: readonly Scanner[] = SKILLS_SH_PARTNERS.map(
  (partner) => partnerScanner(partner)
);
