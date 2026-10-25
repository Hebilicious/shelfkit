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
      "A section of the repository's AGENTS.md, which every agent reads in every session.",
    label: "Instructions",
    plural: "Instructions",
  },
  library: {
    about:
      "What an agent needs to know to use one library or tool the way this shelf wants it used.",
    installs:
      "These notes, in the repository's AGENTS.md, which every agent reads in every session.",
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
      "These conventions, in the repository's AGENTS.md, which every agent reads in every session.",
    label: "Tech stack",
    plural: "Tech stacks",
  },
};

/** The kinds in the order the sidebar lists them (`KIND_GROUPS`), which every list follows. */
export const KIND_ORDER: readonly ItemKind[] = [
  "prompt",
  "instructions",
  "stack",
  "library",
  "skill",
  "mcp",
  "agent",
  "hook",
  "lsp",
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

/** What a kind's own page says about it: what it is, what the agent gets, and one example. */
export interface KindGuide {
  /** The kind's address under the shelf: `/shelves/<shelf>/<slug>`. */
  readonly slug: string;
  readonly what: string;
  readonly gets: string;
  readonly example: string;
}

export const KIND_GUIDES: Readonly<Record<ItemKind, KindGuide>> = {
  agent: {
    example:
      "A registry reviewer that checks a change against the wire contract and reports each problem.",
    gets: "An agent definition the harness lists beside its own, which you or the main agent can hand a task to.",
    slug: "agents",
    what: "A specialised agent with its own role, instructions, and tools.",
  },
  hook: {
    example: "Format the repository after the agent edits a file.",
    gets: "A command the harness runs on an event, such as after every edit. It runs code, so APM asks before installing it.",
    slug: "hooks",
    what: "Something the harness does automatically while the agent works.",
  },
  instructions: {
    example:
      "“The crates are the product: keep them free of Cloudflare and network dependencies.”",
    gets: "The text, in a section of the repository's AGENTS.md that APM writes. Every agent reads AGENTS.md in every session: Codex, Cursor, and Copilot directly, Claude Code through CLAUDE.md's `@AGENTS.md`.",
    slug: "instructions",
    what: "The rules of one project or team, written for the agent. Unlike library notes and tech stacks, they are not about a particular tool.",
  },
  library: {
    example:
      "Drizzle ORM: “Migrations are generated, never hand-written. Prefer db.query over db.select.”",
    gets: "Exactly what instructions get: the notes go into the AGENTS.md section every agent reads in every session. The difference is that ShelfKit suggests them to a repository that depends on the library.",
    slug: "library-notes",
    what: "What an agent should know to use one library or tool well: the patterns to follow and the mistakes to avoid. Not the library itself; APM and your package manager install that.",
  },
  lsp: {
    example: "rust-analyzer, for types and references in .rs files.",
    gets: "A language server entry, which the harness starts for code intelligence as the agent edits.",
    slug: "language-servers",
    what: "A language server, the same kind an editor runs.",
  },
  mcp: {
    example: "Context7, which looks up current documentation for a library.",
    gets: "An MCP server configured in each harness, whose tools the agent can call.",
    slug: "mcp-servers",
    what: "A server that gives the agent tools: a docs search, a browser, an issue tracker.",
  },
  plugin: {
    example:
      "Release tools: a set of commands and hooks for cutting a release.",
    gets: "The plugin package, installed as a dependency.",
    slug: "plugins",
    what: "A package of skills, agents, hooks, and commands that ship together.",
  },
  prompt: {
    example: "“Review the staged diff, looking hardest at {{focus}}.”",
    gets: "Copy it from here with its variables filled in, or install it: harnesses with slash commands offer it as one.",
    slug: "prompts",
    what: "Text you give an agent to do one job.",
  },
  skill: {
    example:
      "Update the compiler's goldens: the steps, the command, and what to check in the diff.",
    gets: "The whole skill folder: SKILL.md and every file beside it (references, scripts, templates). The agent sees only the name and description until a task calls for the skill; then it reads SKILL.md, which points it at the other files.",
    slug: "skills",
    what: "Know-how for one kind of task, loaded on demand rather than in every session.",
  },
  stack: {
    example:
      "TypeScript on Cloudflare Workers with a Rust core: where code goes, which runtime rules apply, which other items go with it.",
    gets: "Exactly what instructions get: the conventions go into the AGENTS.md section every agent reads in every session. The difference is that ShelfKit recognises a repository built on the stack from its files and dependencies, and suggests the stack and the items it recommends.",
    slug: "tech-stacks",
    what: "The conventions for a combination of tools a project is built with.",
  },
};

/** The shelf's sidebar: kinds grouped by what they do for the agent. */
export const KIND_GROUPS: readonly {
  readonly title: string;
  readonly kinds: readonly ItemKind[];
}[] = [
  { kinds: ["prompt"], title: "For you" },
  {
    kinds: ["instructions", "stack", "library", "skill"],
    title: "What the agent knows",
  },
  {
    kinds: ["mcp", "agent", "hook", "lsp", "plugin"],
    title: "What the agent can use",
  },
];

/** The kind a sidebar address names, or `null`. */
export function kindOfSlug(slug: string): ItemKind | null {
  const found = KIND_ORDER.find((kind) => KIND_GUIDES[kind].slug === slug);
  return found ?? null;
}

/** One file or folder `apm install` writes for one agent. `{id}` stands for the item's id. */
export interface Place {
  readonly agent: string;
  readonly path: string;
}

/** Instructions, tech stacks, and library notes: one section of AGENTS.md, which `apm compile` writes. */
const AGENTS_MD: readonly Place[] = [
  {
    agent: "Codex, Cursor, Copilot",
    path: "AGENTS.md, between <!-- apm:start --> and <!-- apm:end -->",
  },
  {
    agent: "Claude Code",
    path: "CLAUDE.md, which imports AGENTS.md with @AGENTS.md",
  },
];

/**
 * Where each kind lands in a repository, as APM 0.33 installs it for Claude Code, Codex, Copilot, and Cursor. Measured
 * by installing ShelfKit's own shelf; APM owns these paths, so they move when APM does.
 */
export const PLACES: Readonly<Record<ItemKind, readonly Place[]>> = {
  agent: [
    { agent: "Claude Code", path: ".claude/agents/{id}.md" },
    { agent: "Cursor", path: ".cursor/agents/{id}.md" },
    { agent: "Copilot", path: ".github/agents/{id}.agent.md" },
    { agent: "Codex", path: ".codex/agents/{id}.toml" },
  ],
  hook: [
    { agent: "Claude Code", path: ".claude/settings.json" },
    { agent: "Cursor", path: ".cursor/hooks.json" },
    { agent: "Copilot", path: ".github/hooks/<profile>-{id}.json" },
    { agent: "Codex", path: ".codex/hooks.json" },
  ],
  instructions: AGENTS_MD,
  library: AGENTS_MD,
  lsp: [
    {
      agent: "Claude Code",
      path: ".claude/skills/apm-lsp/ (a plugin APM writes)",
    },
    { agent: "Copilot", path: ".github/lsp.json" },
  ],
  mcp: [
    { agent: "Claude Code", path: ".mcp.json" },
    { agent: "Cursor", path: ".cursor/mcp.json" },
    { agent: "Copilot", path: ".github/mcp.json" },
    { agent: "Codex", path: ".codex/config.toml" },
  ],
  plugin: [
    {
      agent: "Every agent",
      path: "what the plugin holds, each part where its kind goes",
    },
  ],
  prompt: [
    { agent: "Claude Code", path: ".claude/commands/{id}.md (as /{id})" },
    { agent: "Cursor", path: ".cursor/commands/{id}.md" },
    { agent: "Copilot", path: ".github/prompts/{id}.prompt.md" },
  ],
  skill: [
    { agent: "Claude Code", path: ".claude/skills/{id}/ (the whole folder)" },
    {
      agent: "Codex, Copilot, Cursor",
      path: ".agents/skills/{id}/ (the whole folder)",
    },
  ],
  stack: AGENTS_MD,
};

/** The places of one item, with its id filled in. */
export function placesOf(kind: ItemKind, id: string): Place[] {
  return PLACES[kind].map((place) => ({
    ...place,
    path: place.path.replaceAll("{id}", id),
  }));
}

/**
 * Instructions, tech stacks, and library notes all install the same way: into one section of AGENTS.md, which every
 * agent reads in every session. What differs is only how they are written, and that a tech stack and library notes
 * are suggested to a repository that uses the tool.
 */
export const RULES_NOTE =
  "An AGENTS.md you wrote stays yours: APM writes only between the two marker lines ShelfKit adds at its end, and keeps the rest as it is. Claude Code reads CLAUDE.md rather than AGENTS.md, so CLAUDE.md gets one line, @AGENTS.md, that brings AGENTS.md in. None of them becomes a rule file.";
