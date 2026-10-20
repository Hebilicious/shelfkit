/**
 * Licences, and what each lets ShelfKit do with an artifact (`docs/PRD.md` section 11, point 5).
 *
 * Licence risk is concentrated and correlated, so the rule is enforced here rather than left to convention: an
 * artifact whose licence ShelfKit cannot identify as one that permits copying contributes URLs and provenance, never
 * content. That covers no licence at all, a proprietary notice, and the Creative Commons NoDerivatives and
 * NonCommercial licences, whose terms a shelf (which re-publishes as a registry) cannot promise to keep.
 */

/** What a licence obliges and allows, as far as importing goes. */
export interface Licence {
  /** The SPDX identifier, when there is one. */
  readonly id: string | undefined;
  /** The licence as the source states it, for the item's `source.license`. */
  readonly statement: string;
  /** Whether a copy may be kept and served. `false` makes the import link-only. */
  readonly permitsCopy: boolean;
  /** Whether derived work must carry the same licence. */
  readonly shareAlike: boolean;
  /** Whether a copy must credit the author. */
  readonly attribution: boolean;
}

interface Known {
  readonly shareAlike: boolean;
  readonly attribution: boolean;
}

/** SPDX licences that permit keeping and serving a copy. */
const PERMISSIVE = new Map<string, Known>([
  ["0BSD", { attribution: false, shareAlike: false }],
  ["AGPL-3.0", { attribution: true, shareAlike: true }],
  ["AGPL-3.0-only", { attribution: true, shareAlike: true }],
  ["AGPL-3.0-or-later", { attribution: true, shareAlike: true }],
  ["Apache-2.0", { attribution: true, shareAlike: false }],
  ["BSD-2-Clause", { attribution: true, shareAlike: false }],
  ["BSD-3-Clause", { attribution: true, shareAlike: false }],
  ["CC-BY-4.0", { attribution: true, shareAlike: false }],
  ["CC-BY-SA-4.0", { attribution: true, shareAlike: true }],
  ["CC0-1.0", { attribution: false, shareAlike: false }],
  ["GPL-2.0", { attribution: true, shareAlike: true }],
  ["GPL-2.0-only", { attribution: true, shareAlike: true }],
  ["GPL-2.0-or-later", { attribution: true, shareAlike: true }],
  ["GPL-3.0", { attribution: true, shareAlike: true }],
  ["GPL-3.0-only", { attribution: true, shareAlike: true }],
  ["GPL-3.0-or-later", { attribution: true, shareAlike: true }],
  ["ISC", { attribution: true, shareAlike: false }],
  ["LGPL-3.0", { attribution: true, shareAlike: true }],
  ["MIT", { attribution: true, shareAlike: false }],
  ["MIT-0", { attribution: false, shareAlike: false }],
  ["MPL-2.0", { attribution: true, shareAlike: true }],
  ["Unlicense", { attribution: false, shareAlike: false }],
  ["Zlib", { attribution: true, shareAlike: false }],
]);

/** The licence of an SPDX identifier, or `undefined` for one this table does not know. */
export function fromSpdx(
  id: string,
  statement: string = id
): Licence | undefined {
  const exact = [...PERMISSIVE.keys()].find(
    (known) => known.toLowerCase() === id.trim().toLowerCase()
  );
  if (exact === undefined) {
    return undefined;
  }
  const known = PERMISSIVE.get(exact);
  return known === undefined
    ? undefined
    : { ...known, id: exact, permitsCopy: true, statement };
}

/** A licence ShelfKit could not identify as permitting copies: the import is link-only. */
export function restrictive(statement: string, id?: string): Licence {
  return {
    attribution: true,
    id,
    permitsCopy: false,
    shareAlike: false,
    statement,
  };
}

/** No licence at all. */
export const NO_LICENCE: Licence = restrictive("none stated");

/**
 * Words that put terms on top of, or instead of, an open licence. A licence file that contains any of them is never
 * read as permissive, whatever else it quotes: a source-available licence often names the open licence it converts
 * to later (Sentry's FSL-1.1-Apache-2.0), and a proprietary notice often names the licences of bundled parts.
 */
const RESTRICTIONS =
  /NonCommercial|NoDerivatives|BY-NC|BY-ND|non-commercial|Functional Source License|Business Source License|Elastic License|Server Side Public License|Commons Clause|all rights reserved|proprietary|PolyForm|Sustainable Use License/iu;

/** The opening of each full licence text, after any title and copyright lines, and the clause that completes it. */
const FULL_TEXTS: readonly { id: string; opening: RegExp; clause: RegExp }[] = [
  {
    clause: /TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION/u,
    id: "Apache-2.0",
    opening: /^Apache License,? Version 2\.0, January 2004\b/u,
  },
  {
    clause: /THE SOFTWARE IS PROVIDED "AS IS"/u,
    id: "MIT-0",
    opening:
      /^Permission is hereby granted, free of charge, to any person obtaining a copy of this software\b(?:(?!The above copyright notice).)*$/u,
  },
  {
    clause:
      /The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software\./u,
    id: "MIT",
    opening:
      /^Permission is hereby granted, free of charge, to any person obtaining a copy of this software\b/u,
  },
  {
    clause: /Neither the name of/u,
    id: "BSD-3-Clause",
    opening:
      /^Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met/u,
  },
  {
    clause: /THIS SOFTWARE IS PROVIDED BY/u,
    id: "BSD-2-Clause",
    opening:
      /^Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met/u,
  },
  {
    clause: /THE SOFTWARE IS PROVIDED "AS IS"/u,
    id: "ISC",
    opening:
      /^Permission to use, copy, modify, and\/or distribute this software for any purpose with or without fee is hereby granted/u,
  },
  {
    clause: /Statement of Purpose/u,
    id: "CC0-1.0",
    opening: /^(?:Creative Commons Legal Code )?CC0 1\.0 Universal\b/u,
  },
  {
    clause:
      /Anyone is free to copy, modify, publish, use, compile, sell, or distribute this software/u,
    id: "Unlicense",
    opening:
      /^This is free and unencumbered software released into the public domain\./u,
  },
  {
    clause: /1\. Definitions/u,
    id: "MPL-2.0",
    opening: /^Mozilla Public License,? Version 2\.0\b/u,
  },
  {
    clause: /TERMS AND CONDITIONS/u,
    id: "AGPL-3.0",
    opening:
      /^GNU AFFERO GENERAL PUBLIC LICENSE Version 3, 19 November 2007\b/u,
  },
  {
    clause: /additional permissions/u,
    id: "LGPL-3.0",
    opening: /^GNU LESSER GENERAL PUBLIC LICENSE Version 3, 29 June 2007\b/u,
  },
  {
    clause: /TERMS AND CONDITIONS/u,
    id: "GPL-3.0",
    opening: /^GNU GENERAL PUBLIC LICENSE Version 3, 29 June 2007\b/u,
  },
  {
    clause: /TERMS AND CONDITIONS FOR COPYING, DISTRIBUTION AND MODIFICATION/u,
    id: "GPL-2.0",
    opening: /^GNU GENERAL PUBLIC LICENSE Version 2, June 1991\b/u,
  },
  {
    clause: /Section 1 . Definitions/u,
    id: "CC-BY-SA-4.0",
    opening:
      /^(?:Creative Commons Corporation .*?)?Attribution-ShareAlike 4\.0 International\b/u,
  },
  {
    clause: /Section 1 . Definitions/u,
    id: "CC-BY-4.0",
    opening:
      /^(?:Creative Commons Corporation .*?)?Attribution 4\.0 International\b/u,
  },
];

/** A title or copyright line that may precede a licence's text. */
const PREAMBLE =
  /^(?:#+\s*)?(?:(?:the\s+)?(?:mit|isc|bsd)[\w .()-]*licen[cs]e(?:\s*\(mit\))?|copyright\b.*|\(c\)\s.*|\u00A9.*|spdx-license-identifier:.*|[-=*_\s]*)$/iu;

/** The body of a licence file: its lines after any title and copyright lines, joined with single spaces. */
function body(text: string): string {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  const first = lines.findIndex((line) => !PREAMBLE.test(line.trim()));
  return (first === -1 ? "" : lines.slice(first).join(" "))
    .replaceAll(/\s+/gu, " ")
    .trim();
}

/** An `SPDX-License-Identifier:` header naming one permissive licence, as the first non-blank line. */
function spdxHeader(text: string): Licence | undefined {
  const firstLine = text.trimStart().split("\n")[0] ?? "";
  const id =
    /^(?:\/\/|#|<!--|\/\*)?\s*SPDX-License-Identifier:\s*(?<id>[\w.+-]+)\s*(?:-->|\*\/)?\s*$/u.exec(
      firstLine.trim()
    )?.groups?.id;
  return id === undefined ? undefined : fromSpdx(id);
}

/**
 * Identify a licence file's text. A file is permissive only when it is one licence's full text (its opening, after
 * any title and copyright lines, and the clause that completes it) or starts with an `SPDX-License-Identifier` naming
 * one, and carries none of the words that restrict an open licence. Anything else is restrictive, because guessing
 * "permissive" is the expensive mistake.
 */
export function classifyText(text: string): Licence {
  const flat = text.replaceAll(/\s+/gu, " ").trim();
  const head = flat.slice(0, 160);
  const unrecognised = restrictive(
    head === "" ? "an empty licence file" : `unrecognised: ${head}`
  );
  // A copyright line may say "All rights reserved" above an open licence (BSD's template does); the terms are below it.
  const rest = body(text);
  if (RESTRICTIONS.test(rest)) {
    return unrecognised;
  }
  const header = spdxHeader(text);
  if (header !== undefined) {
    return header;
  }
  const found = FULL_TEXTS.find(
    (entry) => entry.opening.test(rest) && entry.clause.test(rest)
  );
  return found === undefined
    ? unrecognised
    : (fromSpdx(found.id) ?? unrecognised);
}

/**
 * Read a `license` statement from SKILL.md frontmatter. An SPDX id on the permissive allowlist is that licence; a
 * pointer to the licence file ("Complete terms in LICENSE.txt") defers to the file, which then decides alone; anything
 * else (another SPDX id, a `LicenseRef-`, a proprietary notice, free text) is restrictive.
 */
export function fromStatement(statement: string): Licence | "see-file" {
  const trimmed = statement.trim();
  const spdx = fromSpdx(trimmed);
  if (spdx !== undefined) {
    return spdx;
  }
  if (
    /^(?:complete |full )?(?:terms|license|licence)(?: terms)? (?:in|at|see) [\w./-]*licen[cs]e[\w.]*$|^see licen[cs]e[\w.]*$/iu.test(
      trimmed
    )
  ) {
    return "see-file";
  }
  return restrictive(trimmed);
}

/** Whether a path's file name is a licence file: `LICENSE`, `LICENSE.txt`, `LICENCE.md`, `COPYING`, and so on. */
export function isLicenceFile(name: string): boolean {
  return /^(?:licen[cs]e|copying)(?:[.-][\w.-]*)?$/iu.test(name);
}

/** The fields a licence contributes to an item's `source`. */
export interface LicenceFields {
  license: string;
  licenseId?: string;
  shareAlike: boolean;
}

/** The fields a licence contributes to an item's `source`. */
export function licenceFields(licence: Licence): LicenceFields {
  const fields: LicenceFields = {
    license: licence.statement,
    shareAlike: licence.shareAlike,
  };
  if (licence.id !== undefined) {
    fields.licenseId = licence.id;
  }
  return fields;
}
