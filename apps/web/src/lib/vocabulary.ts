/**
 * The words the UI uses for the shelf format's terms, in one place. The format's names (`library`, `stack`,
 * `vendored`, `coordinate`, `compile`) are precise for the CLI and the PRD but mean nothing to someone looking at a
 * page, so the screens never print them raw: they print a label from here, and the sentence beside it says what the
 * thing does for the agent. APM's own words (`apm.yml`, `apm install`, skills, prompts, instructions) are kept, since
 * they are what the reader will meet in the repository.
 */
import type { ItemKind } from "../data/shelf.ts";

export interface KindWords {
  /** The kind's name in a sentence or a heading. */
  readonly label: string;
  /** The plural, for filters and counts. */
  readonly plural: string;
  /** What an item of this kind is, for someone who has never seen one. */
  readonly about: string;
  /** What ends up in a repository that installs it. */
  readonly installs: string;
}

export const KINDS: Readonly<Record<ItemKind, KindWords>> = {
  agent: {
    about:
      "A custom agent: a role, its instructions, and the tools it may use.",
    installs: "An .agent.md file the harness offers as an agent.",
    label: "Agent",
    plural: "Agents",
  },
  hook: {
    about:
      "A command the harness runs on agent events, such as before a tool call.",
    installs:
      "A hook definition. It runs code, so APM asks for approval before installing it.",
    label: "Hook",
    plural: "Hooks",
  },
  instructions: {
    about: "Project conventions the agent follows in every session.",
    installs:
      "An instructions file, which APM writes into each harness's rules (CLAUDE.md, AGENTS.md, …).",
    label: "Instructions",
    plural: "Instructions",
  },
  library: {
    about:
      "What an agent needs to know to use one library or tool the way this shelf wants it used.",
    installs:
      "An instructions file with these notes, which the agent reads in every session.",
    label: "Library notes",
    plural: "Library notes",
  },
  lsp: {
    about: "A language server the harness runs for code intelligence.",
    installs: "A language server entry in apm.yml.",
    label: "Language server",
    plural: "Language servers",
  },
  mcp: {
    about:
      "An MCP server: tools the agent can call, such as a database or a docs search.",
    installs:
      "An MCP server entry in apm.yml, which APM configures in each harness.",
    label: "MCP server",
    plural: "MCP servers",
  },
  plugin: {
    about: "An agent plugin package: several of the above, shipped together.",
    installs: "The plugin package, as an APM dependency.",
    label: "Plugin",
    plural: "Plugins",
  },
  prompt: {
    about:
      "A reusable prompt you copy into an agent, or run as a slash command.",
    installs:
      "A prompt file, which harnesses with slash commands offer as one.",
    label: "Prompt",
    plural: "Prompts",
  },
  skill: {
    about:
      "A skill: instructions and files the agent loads when a task calls for them.",
    installs: "A skill folder with its SKILL.md.",
    label: "Skill",
    plural: "Skills",
  },
  stack: {
    about:
      "The conventions for a combination of tools (a tech stack), and how to recognise a repository that uses it.",
    installs:
      "An instructions file with these conventions, which the agent reads in every session.",
    label: "Tech stack",
    plural: "Tech stacks",
  },
};

/** The kinds in the order the filters list them: the everyday ones first. */
export const KIND_ORDER: readonly ItemKind[] = [
  "prompt",
  "skill",
  "instructions",
  "stack",
  "library",
  "agent",
  "mcp",
  "lsp",
  "hook",
  "plugin",
];

/** What a coordinate kind (where an item lands in `apm.yml`) means, as a sentence about this item. */
export function installSentence(coordinate: {
  kind: string;
  name?: string | null;
}): string {
  switch (coordinate.kind) {
    case "vendored": {
      return "ShelfKit writes its text into the profile's own APM package, in the repository, so it installs with nothing else to fetch.";
    }
    case "upstream": {
      return "apm.yml points at where it came from, pinned to the exact version on this shelf, and APM fetches it from there.";
    }
    case "mcp": {
      return "apm.yml lists it under MCP servers, and APM configures it in each harness.";
    }
    case "lsp": {
      return "apm.yml lists it under language servers, and APM configures it in each harness.";
    }
    case "unresolvable": {
      return "It cannot be installed: ShelfKit cannot tell APM where to fetch it from.";
    }
    default: {
      return "";
    }
  }
}

/** Where an item came from, in a few words. */
export function originLabel(drift: string): string {
  switch (drift) {
    case "authored": {
      return "Written in this shelf";
    }
    case "current": {
      return "Imported · up to date";
    }
    case "moved": {
      return "Imported · newer version upstream";
    }
    case "gone": {
      return "Imported · gone upstream";
    }
    case "error": {
      return "Imported · upstream unreachable";
    }
    default: {
      return "Imported";
    }
  }
}

/** A scan verdict as a person reads it; `null` when there is nothing worth saying. */
export function scanLabel(status: string): string | null {
  switch (status) {
    case "clean": {
      return "Scanned · clean";
    }
    case "disputed": {
      return "Scanners disagree";
    }
    case "flagged": {
      return "Flagged by a scanner";
    }
    default: {
      return null;
    }
  }
}

/** A revision hash, short enough to read: `sha256-c7601ef1…` becomes `c7601ef1`. */
export function shortRevision(revision: string): string {
  return revision.replace(/^sha256-/u, "").slice(0, 8);
}

/** How long ago a timestamp was, in words. */
export function ago(timestamp: string | null | undefined): string {
  if (timestamp === null || timestamp === undefined) {
    return "never";
  }
  const seconds = Math.round(
    (Date.now() - new Date(timestamp).getTime()) / 1000
  );
  const units = [
    { size: 60 * 60 * 24 * 365, unit: "year" },
    { size: 60 * 60 * 24 * 30, unit: "month" },
    { size: 60 * 60 * 24, unit: "day" },
    { size: 60 * 60, unit: "hour" },
    { size: 60, unit: "minute" },
  ] as const;
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const { size, unit } of units) {
    if (Math.abs(seconds) >= size) {
      return format.format(-Math.round(seconds / size), unit);
    }
  }
  return "just now";
}

/**
 * What a profile's `compile.onConflict` does, as a sentence: what happens when the repository's own `apm.yml` already
 * declares something the profile also installs.
 */
export function conflictSentence(onConflict: string): string {
  switch (onConflict) {
    case "shelf-wins": {
      return "this shelf's version replaces the repository's";
    }
    case "local-wins": {
      return "the repository keeps its own, and this shelf's is left out";
    }
    default: {
      return "nothing is written, so you can decide";
    }
  }
}

/** A kind of place an import reads from, and what it is in words. */
export interface SourceKindWords {
  readonly kind: string;
  readonly label: string;
}

/** The kinds of place an import reads from. `path` exists only in `shelf.json`'s sources. */
export const SOURCE_KINDS: readonly SourceKindWords[] = [
  { kind: "git", label: "A Git repository of skills, prompts, or a plugin" },
  { kind: "apm-registry", label: "A package in an APM registry" },
  { kind: "shelfkit", label: "A profile of another ShelfKit shelf" },
  { kind: "catalog", label: "An MCP server catalog" },
  { kind: "marketplace", label: "A plugin marketplace" },
  { kind: "path", label: "A local folder" },
];

/** A source kind in a few words, falling back to its slug. */
export function sourceKindLabel(kind: string): string {
  return SOURCE_KINDS.find((entry) => entry.kind === kind)?.label ?? kind;
}

/** Where an import job is, as a person reads it. */
export function importStatusLabel(status: string): string {
  switch (status) {
    case "queued": {
      return "Waiting to start";
    }
    case "discovering": {
      return "Looking for items";
    }
    case "ready": {
      return "Ready: choose what to keep";
    }
    case "importing": {
      return "Importing";
    }
    case "done": {
      return "Done";
    }
    case "failed": {
      return "Failed";
    }
    default: {
      return status;
    }
  }
}

/** What happened when a repository installed a profile (`shelf.report`'s `outcome`). */
export function outcomeLabel(outcome: string): string {
  switch (outcome) {
    case "applied": {
      return "Files written";
    }
    case "installed": {
      return "Installed with APM";
    }
    case "failed": {
      return "Failed";
    }
    default: {
      return outcome;
    }
  }
}
