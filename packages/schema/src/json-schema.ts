/**
 * Valibot to JSON Schema 2020-12, for the AcidCat catalog and for `@acid-cat/core-ts`'s `toJsonSchema` option (the MCP
 * binding's `inputSchema` and `outputSchema`). Types shared between capabilities become named `$defs`, so the catalog
 * names them once and code generators make one type for each.
 */
import type { StandardSchemaV1, ToJsonSchema } from "@acid-cat/core-ts";
import { toJsonSchema } from "@valibot/to-json-schema";
import type { OverrideActionContext } from "@valibot/to-json-schema";
import type { GenericSchema } from "valibot";

import {
  CompileOptionsSchema,
  CompileSettingsSchema,
  ItemSchema,
  ItemSummarySchema,
  MarkersSchema,
  NoticeSchema,
  ProfileSchema,
  ProfileSummarySchema,
  ResolvedItemSchema,
  ResolvedProfileSchema,
  SourceSchema,
} from "./shelf.ts";

/** The shared types, by the name the catalog gives them. */
export const definitions = {
  CompileOptions: CompileOptionsSchema,
  CompileSettings: CompileSettingsSchema,
  Item: ItemSchema,
  ItemSummary: ItemSummarySchema,
  Markers: MarkersSchema,
  Notice: NoticeSchema,
  Profile: ProfileSchema,
  ProfileSummary: ProfileSummarySchema,
  ResolvedItem: ResolvedItemSchema,
  ResolvedProfile: ResolvedProfileSchema,
  Source: SourceSchema,
};

/**
 * JSON Schema patterns carry no flags, and the converter refuses any. Every pattern here is ASCII-only, where the `u`
 * flag (which the linter requires) changes nothing, so a `u`-only pattern converts to its source. Any other flag still
 * fails the conversion.
 */
function unicodePattern({ jsonSchema, valibotAction }: OverrideActionContext) {
  if (valibotAction.type !== "regex" || !("requirement" in valibotAction)) {
    return null;
  }
  const { requirement } = valibotAction;
  return requirement instanceof RegExp && requirement.flags === "u"
    ? { ...jsonSchema, pattern: requirement.source }
    : null;
}

function isValibotSchema(
  schema: StandardSchemaV1
): schema is StandardSchemaV1 & GenericSchema {
  return schema["~standard"].vendor === "valibot";
}

/** Convert one of this package's schemas. Any other Standard Schema is a programming error. */
export const toCatalogJsonSchema: ToJsonSchema = (schema) => {
  if (!isValibotSchema(schema)) {
    throw new TypeError(
      `expected a Valibot schema, got one from ${schema["~standard"].vendor}`
    );
  }
  // A copy, because an object type made by spreading has the index signature `JsonObject` asks for and the
  // converter's interface does not.
  return {
    ...toJsonSchema(schema, {
      definitions,
      overrideAction: unicodePattern,
      target: "draft-2020-12",
    }),
  };
};
