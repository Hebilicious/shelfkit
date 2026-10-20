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
  readonly test: (line: string) => boolean;
  readonly severity: "suspicious" | "malicious";
  readonly message: string;
}

/** A shell at the start of a pipeline stage. Anchored, so each stage is read once. */
const SHELL = /^\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/iu;
const POWERSHELL_EVAL = /^\s*iex\b/iu;
const DOWNLOAD = /\b(?:curl|wget)\b/iu;
const POWERSHELL_DOWNLOAD = /\b(?:iwr|Invoke-WebRequest)\b/iu;
const DECODE = /\bbase64\s+(?:-d|--decode)\b/iu;

/** Whether a stage matching `from` pipes straight into a stage matching `into`. Linear in the line. */
function pipes(line: string, from: RegExp, into: RegExp): boolean {
  const stages = line.split("|");
  return stages.some((stage, index) => {
    const next = stages[index + 1];
    return next !== undefined && from.test(stage) && into.test(next);
  });
}

/** Whether any stage decodes data and a later stage is a shell. */
function decodedIntoShell(line: string): boolean {
  let decoded = false;
  for (const stage of line.split("|")) {
    if (decoded && SHELL.test(stage)) {
      return true;
    }
    decoded ||= DECODE.test(stage);
  }
  return false;
}

/** Patterns are anchored on fixed text and every repetition is bounded, so no line costs more than linear time. */
const HIDDEN =
  /[\u202A-\u202E\u2066-\u2069\u200B-\u200D\u2060]|[\u{E0000}-\u{E007F}]/u;
const CREDENTIAL =
  /\bgh[pousr]_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{40,255}|\bsk-[A-Za-z0-9_-]{32,255}|\bAKIA[0-9A-Z]{16}\b|\bxox[abprs]-[A-Za-z0-9-]{10,255}|-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/u;
const OVERRIDE =
  /\b(?:ignore|disregard|forget) {1,8}(?:all {1,8})?(?:of {1,8})?(?:the {1,8}|your {1,8})?(?:previous|prior|above|earlier) {1,8}instructions\b/iu;
const CREDENTIAL_READ =
  /(?:~|\$HOME|\$\{HOME\})\/\.(?:ssh|aws|gnupg|kube|docker\/config\.json)\b/u;

const RULES: readonly Rule[] = [
  {
    id: "decoded-shell",
    message: "decodes data and pipes it into a shell",
    severity: "malicious",
    test: decodedIntoShell,
  },
  {
    id: "pipe-to-shell",
    message: "pipes a download into a shell",
    severity: "suspicious",
    test: (line) =>
      pipes(line, DOWNLOAD, SHELL) ||
      pipes(line, POWERSHELL_DOWNLOAD, POWERSHELL_EVAL),
  },
  {
    id: "hidden-characters",
    message:
      "contains characters a reader cannot see (bidirectional controls, zero-width, or tag characters)",
    severity: "suspicious",
    test: (line) => HIDDEN.test(line),
  },
  {
    id: "credential",
    message: "contains what looks like a credential",
    severity: "suspicious",
    test: (line) => CREDENTIAL.test(line),
  },
  {
    id: "instruction-override",
    message: "tells the agent to discard its prior instructions",
    severity: "suspicious",
    test: (line) => OVERRIDE.test(line.replaceAll(/\s/gu, " ")),
  },
  {
    id: "credential-read",
    message: "reads an SSH, cloud, or GPG credential directory",
    severity: "suspicious",
    test: (line) => CREDENTIAL_READ.test(line),
  },
];

/** The most of one file the scanner reads; a larger file is flagged as not fully scanned. */
export const MAX_SCANNED_CHARACTERS = 2 * 1024 * 1024;

/** Magic numbers of executables: ELF, PE, and Mach-O. */
function isExecutable(bytes: string): boolean {
  return (
    bytes.startsWith("\u007FELF") ||
    bytes.startsWith("MZ") ||
    [
      "\u00CF\u00FA\u00ED\u00FE",
      "\u00CE\u00FA\u00ED\u00FE",
      "\u00CA\u00FE\u00BA\u00BE",
    ].some((magic) => bytes.startsWith(magic))
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
  if (file.contents.length > MAX_SCANNED_CHARACTERS) {
    findings.push({
      message: `is longer than the ${MAX_SCANNED_CHARACTERS} characters the scanner reads, so it was not fully scanned`,
      rule: "too-large",
      severity: "suspicious",
      where: file.path,
    });
  }
  const lines = file.contents
    .slice(0, MAX_SCANNED_CHARACTERS)
    .replaceAll("\r\n", "\n")
    .split("\n");
  for (const rule of RULES) {
    const line = lines.findIndex((text) => rule.test(text));
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
    let verdict: ScanVerdict["verdict"] = "clean";
    if (findings.some((finding) => finding.severity === "malicious")) {
      verdict = "malicious";
    } else if (findings.length > 0) {
      verdict = "suspicious";
    }
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
