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
const PERMISSIVE: Readonly<Record<string, Known>> = {
  "0BSD": { attribution: false, shareAlike: false },
  "AGPL-3.0": { attribution: true, shareAlike: true },
  "AGPL-3.0-only": { attribution: true, shareAlike: true },
  "AGPL-3.0-or-later": { attribution: true, shareAlike: true },
  "Apache-2.0": { attribution: true, shareAlike: false },
  "BSD-2-Clause": { attribution: true, shareAlike: false },
  "BSD-3-Clause": { attribution: true, shareAlike: false },
  "CC-BY-4.0": { attribution: true, shareAlike: false },
  "CC-BY-SA-4.0": { attribution: true, shareAlike: true },
  "CC0-1.0": { attribution: false, shareAlike: false },
  "GPL-2.0": { attribution: true, shareAlike: true },
  "GPL-2.0-only": { attribution: true, shareAlike: true },
  "GPL-2.0-or-later": { attribution: true, shareAlike: true },
  "GPL-3.0": { attribution: true, shareAlike: true },
  "GPL-3.0-only": { attribution: true, shareAlike: true },
  "GPL-3.0-or-later": { attribution: true, shareAlike: true },
  ISC: { attribution: true, shareAlike: false },
  "LGPL-3.0": { attribution: true, shareAlike: true },
  MIT: { attribution: true, shareAlike: false },
  "MIT-0": { attribution: false, shareAlike: false },
  "MPL-2.0": { attribution: true, shareAlike: true },
  Unlicense: { attribution: false, shareAlike: false },
  Zlib: { attribution: true, shareAlike: false },
};

/** The licence of an SPDX identifier, or `undefined` for one this table does not know. */
export function fromSpdx(
  id: string,
  statement: string = id
): Licence | undefined {
  const exact = Object.keys(PERMISSIVE).find(
    (known) => known.toLowerCase() === id.trim().toLowerCase()
  );
  if (exact === undefined) {
    return undefined;
  }
  const known = PERMISSIVE[exact];
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
 * Identify a licence file's text. The patterns are the licences' own fixed wording, so the answer is deterministic;
 * anything unrecognised is restrictive, because guessing "permissive" is the expensive mistake.
 */
export function classifyText(text: string): Licence {
  const flat = text.replaceAll(/\s+/gu, " ").trim();
  const head = flat.slice(0, 600);
  const says = (pattern: RegExp): boolean => pattern.test(flat);

  if (
    says(/Attribution-NonCommercial|Attribution-NoDerivatives|BY-NC|BY-ND/iu)
  ) {
    const id = /NonCommercial-NoDerivatives|BY-NC-ND/iu.test(flat)
      ? "CC-BY-NC-ND-4.0"
      : /NoDerivatives|BY-ND/iu.test(flat)
        ? "CC-BY-ND-4.0"
        : "CC-BY-NC-4.0";
    return restrictive(`${id}: no derivatives or no commercial use`, id);
  }
  const permissive: [RegExp, string][] = [
    [/Apache License,? Version 2\.0/iu, "Apache-2.0"],
    [/MIT No Attribution/iu, "MIT-0"],
    [
      /Permission is hereby granted, free of charge.*without restriction.*The above copyright notice/iu,
      "MIT",
    ],
    [
      /Permission is hereby granted, free of charge.*without restriction/iu,
      "MIT-0",
    ],
    [/Creative Commons (Legal Code )?CC0 1\.0 Universal|CC0 1\.0/iu, "CC0-1.0"],
    [
      /This is free and unencumbered software released into the public domain/iu,
      "Unlicense",
    ],
    [/Mozilla Public License,? (Version )?2\.0/iu, "MPL-2.0"],
    [/GNU AFFERO GENERAL PUBLIC LICENSE Version 3/iu, "AGPL-3.0"],
    [/GNU LESSER GENERAL PUBLIC LICENSE Version 3/iu, "LGPL-3.0"],
    [/GNU GENERAL PUBLIC LICENSE Version 3/iu, "GPL-3.0"],
    [/GNU GENERAL PUBLIC LICENSE Version 2/iu, "GPL-2.0"],
    [/Attribution-ShareAlike 4\.0 International/iu, "CC-BY-SA-4.0"],
    [/Attribution 4\.0 International/iu, "CC-BY-4.0"],
    [
      /Redistribution and use in source and binary forms.*Neither the name/iu,
      "BSD-3-Clause",
    ],
    [/Redistribution and use in source and binary forms/iu, "BSD-2-Clause"],
    [
      /Permission to use, copy, modify, and\/or distribute this software for any purpose/iu,
      "ISC",
    ],
  ];
  for (const [pattern, id] of permissive) {
    if (says(pattern)) {
      return fromSpdx(id) ?? restrictive(head, id);
    }
  }
  return restrictive(
    head === ""
      ? "an empty licence file"
      : `unrecognised: ${head.slice(0, 160)}`
  );
}

/**
 * Read a `license` statement from SKILL.md frontmatter: an SPDX id that permits copying, a pointer to the licence
 * file ("Complete terms in LICENSE.txt"), or a restriction ("Proprietary").
 */
export function fromStatement(
  statement: string
): Licence | "see-file" | undefined {
  const trimmed = statement.trim();
  const spdx = fromSpdx(trimmed);
  if (spdx !== undefined) {
    return spdx;
  }
  if (/proprietary|all rights reserved/iu.test(trimmed)) {
    return restrictive(trimmed);
  }
  if (/licen[cs]e(\.txt|\.md)?|terms in/iu.test(trimmed)) {
    return "see-file";
  }
  return undefined;
}

/** Whether a path's file name is a licence file: `LICENSE`, `LICENSE.txt`, `LICENCE.md`, `COPYING`, and so on. */
export function isLicenceFile(name: string): boolean {
  return /^(?:licen[cs]e|copying)(?:[.-][\w.-]*)?$/iu.test(name);
}

/** The fields a licence contributes to an item's `source`. */
export function licenceFields(licence: Licence): {
  license: string;
  licenseId?: string;
  shareAlike: boolean;
} {
  return {
    license: licence.statement,
    ...(licence.id === undefined ? {} : { licenseId: licence.id }),
    shareAlike: licence.shareAlike,
  };
}
