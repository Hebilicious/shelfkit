/** Reading `wrangler.jsonc` in Node: JSONC, which `JSON.parse` does not read. */

/** JSONC to JSON: comments and trailing commas removed, strings left alone. */
export function stripJsonc(text: string): string {
  let out = "";
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (inString) {
      out += char;
      if (char === "\\") {
        out += next ?? "";
        index += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
    } else if (char === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") {
        index += 1;
      }
      out += "\n";
    } else if (char === "/" && next === "*") {
      index = text.indexOf("*/", index + 2) + 1;
    } else {
      out += char;
    }
  }
  return out.replaceAll(/,(?<close>\s*[}\]])/gu, "$<close>");
}
