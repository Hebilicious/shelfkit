/**
 * Licence identification: what may be copied. Permissive only for a recognised full licence text, an SPDX header,
 * or an SPDX id on the allowlist; everything else is restrictive.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import * as v from "valibot";
import { describe, expect, it } from "vitest";

import { classifyText, fromStatement } from "../src/licence.ts";
import { ALL_TERMS } from "../src/terms.ts";

const MIT = `MIT License

Copyright (c) 2026 Acme

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
`;

/** The Apache-2.0 text anthropics/skills ships beside a skill, as GitHub served it. */
function apache(): string {
  const recording = v.parse(
    v.object({
      responses: v.record(
        v.string(),
        v.object({ text: v.optional(v.string()) })
      ),
    }),
    JSON.parse(
      readFileSync(
        path.join(import.meta.dirname, "fixtures", "http", "github.json"),
        "utf-8"
      )
    )
  );
  const [text] = Object.entries(recording.responses)
    .filter(([url]) => url.endsWith("/skills/brand-guidelines/LICENSE.txt"))
    .map(([, answer]) => answer.text ?? "");
  return text ?? "";
}

describe("licence files", () => {
  it("are permissive when they are one licence's full text", () => {
    expect(classifyText(MIT).id).toBe("MIT");
    expect(classifyText(apache()).id).toBe("Apache-2.0");
    expect(classifyText("SPDX-License-Identifier: MIT\n").id).toBe("MIT");
    expect(
      classifyText(
        `Copyright (c) 2026 Acme. All rights reserved.\n\n${MIT.split("\n").slice(4).join("\n")}`
      ).id
    ).toBe("MIT");
  });

  it("are restrictive when they only name an open licence: a source-available licence that converts to Apache-2.0", () => {
    const fsl = classifyText(
      "# Functional Source License, Version 1.1, Apache 2.0 Future License\n\n## Abbreviation\n\nFSL-1.1-Apache-2.0\n\nFuture License: Apache License, Version 2.0, January 2004\n"
    );
    expect([fsl.id, fsl.permitsCopy]).toStrictEqual([undefined, false]);
  });

  it("are restrictive when a proprietary notice names the licence of a bundled part", () => {
    const notice = classifyText(
      "Acme Agent Kit. All rights reserved.\n\nThe bundled parser is licensed under the Apache License, Version 2.0, January 2004. TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION apply to it.\n"
    );
    expect(notice.permitsCopy).toBeFalsy();
    expect(
      classifyText(
        "\u00A9 2025 Anthropic, PBC. All rights reserved.\n\nLICENSE: Use of these materials"
      ).permitsCopy
    ).toBeFalsy();
  });

  it("are restrictive for NonCommercial and NoDerivatives licences", () => {
    expect(
      classifyText(
        "Licensed under Creative Commons Attribution-NonCommercial-NoDerivatives 4.0 International"
      ).permitsCopy
    ).toBeFalsy();
  });
});

describe("SKILL.md licence statements", () => {
  it("accept an SPDX id on the allowlist and defer a pointer to the licence file", () => {
    expect(fromStatement("Apache-2.0")).toMatchObject({
      id: "Apache-2.0",
      permitsCopy: true,
    });
    expect(fromStatement("Complete terms in LICENSE.txt")).toBe("see-file");
  });

  it("treat anything else as restrictive: an SPDX id off the allowlist, a LicenseRef, a proprietary notice", () => {
    for (const statement of [
      "CC-BY-NC-4.0",
      "BUSL-1.1",
      "Elastic-2.0",
      "LicenseRef-Acme",
      "Proprietary. LICENSE.txt has complete terms",
      "free for personal use",
    ]) {
      expect({ statement, verdict: fromStatement(statement) }).toMatchObject({
        statement,
        verdict: { permitsCopy: false },
      });
    }
  });
});

describe("source terms", () => {
  it("record every source's terms with a citation and the date they were read", () => {
    for (const terms of ALL_TERMS) {
      expect(terms.citations.length).toBeGreaterThan(0);
      expect(terms.checked).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    }
  });
});
