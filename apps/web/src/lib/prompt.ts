/**
 * What the prompts screen copies. A prompt is `prompt.md` plus declared variables, written `{{name}}` in the body
 * (`docs/PRD.md` section 9.1). The compiler turns each declared variable into APM's `${input:name}`
 * (`crates/compiler/src/vendor.rs`); here the person filling the form gets the final text instead.
 */

/** A declared variable, as `item.json` holds it. */
export interface PromptVariable {
  readonly name: string;
  readonly default?: string | undefined;
  readonly description?: string | undefined;
  readonly required?: boolean | undefined;
}

/** What a prompt needs to be copied: its id, the words that describe it, its body and its variables. */
export interface PromptSource {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly body: string;
  readonly variables: readonly PromptVariable[];
}

/** The three ways to copy a prompt. */
export type CopyFormat = "text" | "skill" | "command";

/** A leading `---` YAML block and the text after it, as the compiler splits one. */
export interface Frontmatter {
  readonly yaml: string;
  readonly rest: string;
}

/** Split a leading `---` YAML block off a markdown file, exactly as `vendor.rs` does, or `null` when there is none. */
export function splitFrontmatter(text: string): Frontmatter | null {
  const normalized = text.replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) {
    return null;
  }
  const rest = normalized.slice("---\n".length);
  const end = rest.indexOf("\n---\n");
  if (end !== -1) {
    return {
      rest: rest.slice(end + "\n---\n".length),
      yaml: rest.slice(0, end),
    };
  }
  if (rest.endsWith("\n---")) {
    return { rest: "", yaml: rest.slice(0, -"\n---".length) };
  }
  return null;
}

/**
 * Whether a `SKILL.md` keeps its skill from the model unless a person asks for it (`disable-model-invocation: true`).
 * Claude Code, Cursor, and Copilot read the key; Codex gets it from the `agents/openai.yaml` the compiler adds.
 */
export function disablesModelInvocation(skillMd: string): boolean {
  const yaml = splitFrontmatter(skillMd)?.yaml ?? "";
  return /^disable-model-invocation:\s*true\s*$/mu.test(yaml);
}

/** The body without its frontmatter, leading blank lines dropped. */
export function bodyText(text: string): string {
  const split = splitFrontmatter(text);
  const body = split === null ? text.replaceAll("\r\n", "\n") : split.rest;
  return body.replace(/^\n+/u, "");
}

/** The value each variable takes: what was typed, else its default, else empty. */
export function resolvedValues(
  variables: readonly PromptVariable[],
  values: ReadonlyMap<string, string>
): Map<string, string> {
  const resolved = new Map<string, string>();
  for (const variable of variables) {
    const typed = values.get(variable.name) ?? "";
    resolved.set(
      variable.name,
      typed === "" ? (variable.default ?? "") : typed
    );
  }
  return resolved;
}

/** The required variables that are still empty, by name. */
export function missingRequired(
  variables: readonly PromptVariable[],
  values: ReadonlyMap<string, string>
): string[] {
  return variables
    .filter(
      (variable) =>
        variable.required === true &&
        (values.get(variable.name) ?? "").trim() === ""
    )
    .map((variable) => variable.name);
}

/** Replace `{{name}}` for every declared variable. An undeclared `{{other}}` stays, as the compiler leaves it. */
export function substitute(
  text: string,
  variables: readonly PromptVariable[],
  replacement: (variable: PromptVariable, index: number) => string
): string {
  let out = text;
  for (const [index, variable] of variables.entries()) {
    out = out.replaceAll(`{{${variable.name}}}`, replacement(variable, index));
  }
  return out;
}

/** The prompt with the form's values filled in, frontmatter dropped: what "Copy" puts on the clipboard. */
export function filledText(
  prompt: PromptSource,
  values: ReadonlyMap<string, string>
): string {
  const resolved = resolvedValues(prompt.variables, values);
  return ensureTrailingNewline(
    substitute(
      bodyText(prompt.body),
      prompt.variables,
      (variable) => resolved.get(variable.name) ?? ""
    )
  );
}

/** A YAML scalar that needs no quoting stays bare; anything else is a double-quoted JSON string, which YAML reads. */
export function yamlScalar(text: string): string {
  const plain =
    /^[A-Za-z0-9][A-Za-z0-9 .,_/()'-]*$/u.test(text) &&
    !/^(?:true|false|null|yes|no|on|off|~)$/iu.test(text) &&
    !text.endsWith(" ");
  return plain ? text : JSON.stringify(text);
}

function describe(prompt: PromptSource): string {
  const description = prompt.description.trim();
  return description === "" ? prompt.title.trim() : description;
}

/**
 * The prompt as an agent skill: a `SKILL.md` whose frontmatter names it and says when to use it, with the form's
 * values filled in, since a skill takes no arguments.
 */
export function asSkill(
  prompt: PromptSource,
  values: ReadonlyMap<string, string>
): string {
  return [
    "---",
    `name: ${prompt.id}`,
    `description: ${yamlScalar(describe(prompt))}`,
    "---",
    "",
    filledText(prompt, values),
  ].join("\n");
}

/** A command's variable: its position among the arguments. */
function positional(_variable: PromptVariable, index: number): string {
  return `$${index + 1}`;
}

/**
 * The prompt as a slash command file (`.claude/commands/<id>.md`): the command takes the variables as positional
 * arguments, so `{{name}}` becomes `$1`, `$2`, … in declaration order and the hint lists them. A `prompt.md` that
 * already has frontmatter keeps it, as the compiler keeps it.
 */
export function asCommand(prompt: PromptSource): string {
  const split = splitFrontmatter(prompt.body);
  if (split !== null) {
    return ensureTrailingNewline(
      `---\n${split.yaml}\n---\n${substitute(split.rest, prompt.variables, positional)}`
    );
  }
  const head = ["---", `description: ${yamlScalar(describe(prompt))}`];
  if (prompt.variables.length > 0) {
    const hint = prompt.variables
      .map((variable) =>
        variable.required === true ? `<${variable.name}>` : `[${variable.name}]`
      )
      .join(" ");
    head.push(`argument-hint: ${JSON.stringify(hint)}`);
  }
  head.push("---", "");
  return ensureTrailingNewline(
    `${head.join("\n")}\n${substitute(bodyText(prompt.body), prompt.variables, positional)}`
  );
}

/** The text one copy format produces. */
export function copyText(
  prompt: PromptSource,
  format: CopyFormat,
  values: ReadonlyMap<string, string>
): string {
  if (format === "skill") {
    return asSkill(prompt, values);
  }
  if (format === "command") {
    return asCommand(prompt);
  }
  return filledText(prompt, values);
}

/** Every `{{name}}` the body uses, in order of first use: the editor offers to declare the undeclared ones. */
export function placeholders(body: string): string[] {
  const names: string[] = [];
  for (const match of body.matchAll(
    /\{\{(?<name>[A-Za-z][A-Za-z0-9_-]*)\}\}/gu
  )) {
    const name = match.groups?.name;
    if (name !== undefined && !names.includes(name)) {
      names.push(name);
    }
  }
  return names;
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}
