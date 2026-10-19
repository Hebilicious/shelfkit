import { byCodePoint } from "../http.ts";
/**
 * ShelfKit's own scanner: deterministic, non-AI, and reading bytes only (`docs/PRD.md` section 11). It never runs,
 * installs, or fetches what it scans. The same revision always gets the same verdict, and the verdict is about the
 * bytes ShelfKit holds for that revision, which is the hash the Worker records it against.
 *
 * It looks for what an agent-facing artifact has no business carrying, or hiding:
 * - a download piped into a shell, and decoded data piped into one (the second is `malicious`);
 * - characters a reader cannot see: bidirectional controls, zero-width characters, and Unicode tag characters;
 * - credential literals: GitHub, OpenAI-style, AWS, and Slack tokens, and private keys;
 * - instructions to discard prior instructions;
 * - reads of SSH, cloud, or GPG credential directories;
 * - executable binaries.
 */
import type {
  ImportedFile,
  ScanSubject,
  ScanVerdict,
  Scanner,
} from "../seam.ts";

interface Rule {
  readonly id: string;
  readonly pattern: RegExp;
  readonly severity: "suspicious" | "malicious";
  readonly message: string;
}

const RULES: readonly Rule[] = [
  {
    id: "decoded-shell",
    message: "decodes data and pipes it into a shell",
    pattern:
      /base64\s+(?:-d|--decode)\b[^\n]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/iu,
    severity: "malicious",
  },
  {
    id: "pipe-to-shell",
    message: "pipes a download into a shell",
    pattern:
      /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b|\b(?:iwr|Invoke-WebRequest)\b[^\n|]*\|\s*iex\b/iu,
    severity: "suspicious",
  },
  {
    id: "hidden-characters",
    message:
      "contains characters a reader cannot see (bidirectional controls, zero-width, or tag characters)",
    pattern: /[‪-‮⁦-⁩​-‍⁠]|[\u{E0000}-\u{E007F}]/u,
    severity: "suspicious",
  },
  {
    id: "credential",
    message: "contains what looks like a credential",
    pattern:
      /\bgh[pousr]_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{40,}|\bsk-[A-Za-z0-9_-]{32,}|\bAKIA[0-9A-Z]{16}\b|\bxox[abprs]-[A-Za-z0-9-]{10,}|-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/u,
    severity: "suspicious",
  },
  {
    id: "instruction-override",
    message: "tells the agent to discard its prior instructions",
    pattern:
      /\b(?:ignore|disregard|forget)\s+(?:all\s+)?(?:of\s+)?(?:the\s+|your\s+)?(?:previous|prior|above|earlier)\s+instructions\b/iu,
    severity: "suspicious",
  },
  {
    id: "credential-read",
    message: "reads an SSH, cloud, or GPG credential directory",
    pattern:
      /(?:~|\$HOME|\$\{HOME\})\/\.(?:ssh|aws|gnupg|kube|docker\/config\.json)\b/u,
    severity: "suspicious",
  },
];

/** Magic numbers of executables: ELF, PE, and Mach-O. */
function isExecutable(bytes: string): boolean {
  return (
    bytes.startsWith("\u007FELF") ||
    bytes.startsWith("MZ") ||
    ["Ïúíþ", "Îúíþ", "Êþº¾"].some((magic) => bytes.startsWith(magic))
  );
}

export interface Finding {
  readonly rule: string;
  readonly severity: "suspicious" | "malicious";
  readonly where: string;
  readonly message: string;
}

function scanFile(file: ImportedFile): Finding[] {
  if (file.encoding === "base64") {
    const head = atob(file.contents.slice(0, 16));
    return isExecutable(head)
      ? [
          {
            message: "is an executable binary",
            rule: "executable",
            severity: "suspicious",
            where: file.path,
          },
        ]
      : [];
  }
  const findings: Finding[] = [];
  const lines = file.contents.replaceAll("\r\n", "\n").split("\n");
  for (const rule of RULES) {
    const line = lines.findIndex((text) => rule.pattern.test(text));
    if (line !== -1) {
      findings.push({
        message: rule.message,
        rule: rule.id,
        severity: rule.severity,
        where: `${file.path}:${line + 1}`,
      });
    }
  }
  return findings;
}

/** Scan files; exported for tests and for `scan` below. */
export function staticFindings(files: readonly ImportedFile[]): Finding[] {
  return files
    .toSorted((a, b) => byCodePoint(a.path, b.path))
    .flatMap((file) => scanFile(file));
}

export const STATIC_SCANNER_ID = "shelfkit-static";

export const staticScanner: Scanner = {
  id: STATIC_SCANNER_ID,
  scan: async (subject: ScanSubject): Promise<ScanVerdict> => {
    const findings = staticFindings(subject.files);
    const verdict = findings.some((finding) => finding.severity === "malicious")
      ? "malicious"
      : findings.length > 0
        ? "suspicious"
        : "clean";
    const summary =
      findings.length === 0
        ? `no findings in ${subject.files.length} file(s)`
        : findings
            .map(
              (finding) =>
                `${finding.where} ${finding.message} [${finding.rule}]`
            )
            .join("; ");
    return await Promise.resolve({
      scanner: STATIC_SCANNER_ID,
      summary,
      verdict,
    });
  },
};
