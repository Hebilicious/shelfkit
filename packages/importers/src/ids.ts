/** Item ids for imported things: kebab-case, at most 64 characters, never `__` (`docs/PRD.md` section 5.2). */

const MAX = 64;

/** The kebab-case form of a name: `My_Skill.v2` is `my-skill-v2`. Empty when nothing usable is left. */
export function kebab(name: string): string {
  return name
    .normalize("NFKD")
    .replaceAll(/[̀-ͯ]/gu, "")
    .replaceAll(/([a-z0-9])([A-Z])/gu, "$1-$2")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, MAX)
    .replace(/-+$/u, "");
}

/** Ids for a list of names, unique among themselves: a repeat gets its `qualifier`, then a number. */
export function uniqueIds(
  wanted: readonly { name: string; qualifier: string }[]
): string[] {
  const taken = new Set<string>();
  return wanted.map(({ name, qualifier }) => {
    const base = kebab(name) || "item";
    const options = [base, kebab(`${base}-${qualifier}`) || base];
    let id = options.find((option) => !taken.has(option));
    for (let n = 2; id === undefined; n += 1) {
      const suffix = `-${n}`;
      const candidate = `${base.slice(0, MAX - suffix.length).replace(/-+$/u, "")}${suffix}`;
      if (!taken.has(candidate)) {
        id = candidate;
      }
    }
    taken.add(id);
    return id;
  });
}
