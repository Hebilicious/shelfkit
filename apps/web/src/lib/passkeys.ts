/**
 * Passkeys in the browser: sign in with one, and add one to the signed-in account. The ceremonies are the Worker's
 * `/auth/passkey/*` routes (`apps/worker/src/auth/passkeys.ts`); the browser's own WebAuthn prompt does the rest.
 * Requests are same-origin `application/json` POSTs, which the Worker requires.
 */
import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import * as v from "valibot";

const TransportSchema = v.picklist([
  "ble",
  "cable",
  "hybrid",
  "internal",
  "nfc",
  "smart-card",
  "usb",
]);
const UserVerificationSchema = v.picklist([
  "required",
  "preferred",
  "discouraged",
]);

const DescriptorSchema = v.object({
  id: v.string(),
  transports: v.optional(v.array(TransportSchema)),
  type: v.literal("public-key"),
});

/** The sign-in options the Worker sends: the fields the browser's prompt needs. */
const RequestOptionsSchema = v.object({
  allowCredentials: v.optional(v.array(DescriptorSchema)),
  challenge: v.string(),
  rpId: v.optional(v.string()),
  timeout: v.optional(v.number()),
  userVerification: v.optional(UserVerificationSchema),
});

/** The registration options the Worker sends. */
const CreationOptionsSchema = v.object({
  attestation: v.optional(
    v.picklist(["direct", "enterprise", "indirect", "none"])
  ),
  authenticatorSelection: v.optional(
    v.object({
      authenticatorAttachment: v.optional(
        v.picklist(["cross-platform", "platform"])
      ),
      requireResidentKey: v.optional(v.boolean()),
      residentKey: v.optional(
        v.picklist(["discouraged", "preferred", "required"])
      ),
      userVerification: v.optional(UserVerificationSchema),
    })
  ),
  challenge: v.string(),
  excludeCredentials: v.optional(v.array(DescriptorSchema)),
  pubKeyCredParams: v.array(
    v.object({ alg: v.number(), type: v.literal("public-key") })
  ),
  rp: v.object({ id: v.optional(v.string()), name: v.string() }),
  timeout: v.optional(v.number()),
  user: v.object({ displayName: v.string(), id: v.string(), name: v.string() }),
});

const SignedInSchema = v.object({ name: v.string(), owner: v.boolean() });
const ProblemSchema = v.object({ detail: v.string() });

/** Any JSON value: what a route's body is before its own schema reads it. */
const JsonSchema = v.nullable(
  v.union([
    v.looseObject({}),
    v.array(v.unknown()),
    v.string(),
    v.number(),
    v.boolean(),
  ])
);

/** Whether this browser can use passkeys at all. */
export function passkeysAvailable(): boolean {
  return browserSupportsWebAuthn();
}

/** POST JSON to a passkey route and parse its JSON answer with `schema`, or throw the Worker's explanation. */
async function post<const TSchema extends v.GenericSchema>(
  path: string,
  body: string,
  schema: TSchema
): Promise<v.InferOutput<TSchema>> {
  const response = await fetch(path, {
    body,
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const text = await response.text();
  if (!response.ok) {
    const problem = v.safeParse(ProblemSchema, parseJson(text));
    throw new Error(
      problem.success
        ? problem.output.detail
        : `the passkey request failed (${response.status})`
    );
  }
  return v.parse(schema, parseJson(text));
}

/** JSON text as a value, or `null` when it is not JSON. BOUNDARY: the caller parses the value with its schema. */
function parseJson(text: string): v.InferOutput<typeof JsonSchema> {
  try {
    return v.parse(JsonSchema, JSON.parse(text));
  } catch {
    return null;
  }
}

/** Sign in with a passkey this device holds. Who it signed in as. */
export async function signInWithPasskey(): Promise<
  v.InferOutput<typeof SignedInSchema>
> {
  const options: PublicKeyCredentialRequestOptionsJSON = await post(
    "/auth/passkey/options",
    "{}",
    RequestOptionsSchema
  );
  const response = await startAuthentication({ optionsJSON: options });
  return await post(
    "/auth/passkey/authenticate",
    JSON.stringify({ response }),
    SignedInSchema
  );
}

/** Make a passkey on this device for the signed-in account, called `label`. */
export async function addPasskey(label: string): Promise<void> {
  const options: PublicKeyCredentialCreationOptionsJSON = await post(
    "/auth/passkey/register/options",
    "{}",
    CreationOptionsSchema
  );
  const response = await startRegistration({ optionsJSON: options });
  await post(
    "/auth/passkey/register",
    JSON.stringify({ label, response }),
    v.object({ passkey: v.object({ id: v.string() }) })
  );
}

const SYSTEMS: readonly (readonly [RegExp, string])[] = [
  [/Windows/u, "Windows"],
  [/Android/u, "Android"],
  [/iPhone|iPad/u, "iOS"],
  [/Mac OS X/u, "macOS"],
  [/Linux/u, "Linux"],
];

const BROWSERS: readonly (readonly [RegExp, string])[] = [
  [/Edg\//u, "Edge"],
  [/Firefox\//u, "Firefox"],
  [/Chrome\//u, "Chrome"],
  [/Safari\//u, "Safari"],
];

function first(
  pairs: readonly (readonly [RegExp, string])[],
  text: string,
  fallback: string
): string {
  return pairs.find(([pattern]) => pattern.test(text))?.[1] ?? fallback;
}

/** A name for a passkey made on this device: the browser and system it runs on, as far as the page can tell. */
export function deviceLabel(): string {
  const agent = navigator.userAgent;
  return `${first(BROWSERS, agent, "a browser")} on ${first(SYSTEMS, agent, "this device")}`;
}
