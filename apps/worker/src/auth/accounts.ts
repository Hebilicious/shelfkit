/**
 * One Durable Object per person who signs in to the browser: the owner (`owner`) and each person the owner invited
 * (`person:<32 hex>`), named by that principal. It holds that person's passkeys, the registration challenges it
 * issued, the authentication challenges it has seen used, and the one-time sign-in links that open their account.
 *
 * It is the per-person counterpart of the per-shelf object: no query spans two of them, and there is no shared
 * database. It keeps a handful of records in the object's key-value storage, so it has no SQL schema to migrate:
 *
 * - `profile`: the principal, a name to show, when it was made, and whether the owner removed it;
 * - `credential:<id>`: a passkey (public key, signature counter, transports, label, created and last used);
 * - `registration:<challenge>`: a registration challenge this object issued, until it is used or expires;
 * - `used:<challenge>`: an authentication challenge already spent here, until it would have expired anyway;
 * - `link:<sha256>`: a sign-in link, by the hash of its token, until it is used or expires;
 * - `cli:<sha256>`: a key the person gave the CLI by approving `shelfkit login` in the browser, by its hash, until
 *   they revoke it or the owner removes the account.
 *
 * A GitHub account's object (`github:<numeric id>`) holds only its CLI keys: it has no profile, passkeys, or links.
 *
 * Every check that makes something single-use reads and deletes in the same synchronous step, before any `await`, so
 * two requests racing with one challenge or one link cannot both succeed.
 */
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { DurableObject } from "cloudflare:workers";
import * as v from "valibot";

import { CHALLENGE_SECONDS, clientChallenge } from "./principals.ts";
import type {
  AccountOutcome,
  CliKeyRecord,
  PasskeyRecord,
  RelyingParty,
} from "./principals.ts";
import { OWNER_PRINCIPAL } from "./session.ts";
import type { Person } from "./session.ts";

const ProfileSchema = v.object({
  createdAt: v.string(),
  name: v.string(),
  principal: v.string(),
  removedAt: v.nullable(v.string()),
});

const CredentialSchema = v.object({
  counter: v.pipe(v.number(), v.integer(), v.minValue(0)),
  createdAt: v.string(),
  id: v.string(),
  label: v.string(),
  lastUsedAt: v.nullable(v.string()),
  publicKey: v.instance(Uint8Array),
  transports: v.array(v.string()),
});

const ExpirySchema = v.object({ expiresAt: v.number() });

const CliKeySchema = v.object({
  createdAt: v.string(),
  id: v.string(),
  lastUsedAt: v.nullable(v.string()),
  name: v.string(),
  /** Who approved it: the principal and, for a GitHub account, which has no profile here, the name to show. */
  person: v.object({ id: v.string(), name: v.string() }),
  prefix: v.string(),
});

type CliKey = v.InferOutput<typeof CliKeySchema>;

type Credential = v.InferOutput<typeof CredentialSchema>;

function now(): string {
  return `${new Date().toISOString().slice(0, 19)}Z`;
}

function seconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** The WebAuthn library, loaded on first use so the Worker's startup stays light. */
async function webauthn() {
  return await import("@simplewebauthn/server");
}

export class AccountIndex extends DurableObject<Env> {
  private get kv(): SyncKvStorage {
    return this.ctx.storage.kv;
  }

  private profileRecord(): v.InferOutput<typeof ProfileSchema> | null {
    const found = v.safeParse(ProfileSchema, this.kv.get("profile"));
    return found.success ? found.output : null;
  }

  /** Make the account if it does not exist. The owner's is made on its first use. */
  ensure(person: Person): Person {
    const existing = this.profileRecord();
    if (existing !== null) {
      return { id: existing.principal, name: existing.name };
    }
    this.kv.put("profile", {
      createdAt: now(),
      name: person.name,
      principal: person.id,
      removedAt: null,
    });
    return person;
  }

  /** The account's person, or `null` when it does not exist or the owner removed it. */
  person(): Person | null {
    const profile = this.profileRecord();
    if (profile === null || profile.removedAt !== null) {
      return null;
    }
    return { id: profile.principal, name: profile.name };
  }

  /**
   * Remove the account: every passkey, sign-in link, and CLI key goes, and its sessions end at their next request, since the
   * Worker asks this object on every request whether the account still exists.
   */
  remove(): boolean {
    const profile = this.profileRecord();
    if (profile === null || profile.principal === OWNER_PRINCIPAL) {
      return false;
    }
    for (const prefix of ["credential:", "registration:", "link:", "cli:"]) {
      for (const [key] of this.kv.list({ prefix })) {
        this.kv.delete(key);
      }
    }
    this.kv.put("profile", { ...profile, removedAt: now() });
    return true;
  }

  private credentials(): Credential[] {
    const found: Credential[] = [];
    for (const [, value] of this.kv.list({ prefix: "credential:" })) {
      const parsed = v.safeParse(CredentialSchema, value);
      if (parsed.success) {
        found.push(parsed.output);
      }
    }
    return found;
  }

  /** Drop challenges and links whose time has passed. */
  private prune(): void {
    const at = seconds();
    for (const prefix of ["registration:", "used:", "link:"]) {
      for (const [key, value] of this.kv.list({ prefix })) {
        const parsed = v.safeParse(ExpirySchema, value);
        if (!parsed.success || parsed.output.expiresAt <= at) {
          this.kv.delete(key);
        }
      }
    }
  }

  // --- Passkeys ----------------------------------------------------------------------------------------------------

  passkeys(): PasskeyRecord[] {
    return this.credentials()
      .map((credential) => ({
        createdAt: credential.createdAt,
        id: credential.id,
        label: credential.label,
        lastUsedAt: credential.lastUsedAt,
      }))
      .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Options for a new passkey on this account. The challenge is kept here, for one use, for `CHALLENGE_SECONDS`. */
  async registrationOptions(rp: RelyingParty) {
    const person = this.person();
    if (person === null) {
      return null;
    }
    const { generateRegistrationOptions } = await webauthn();
    const options = await generateRegistrationOptions({
      attestationType: "none",
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required",
      },
      excludeCredentials: this.credentials().map((credential) => ({
        id: credential.id,
        transports: credential.transports,
      })),
      rpID: rp.id,
      rpName: "ShelfKit",
      timeout: CHALLENGE_SECONDS * 1000,
      userDisplayName: person.name,
      userID: new TextEncoder().encode(person.id),
      userName: person.name,
    });
    this.prune();
    this.kv.put(`registration:${options.challenge}`, {
      expiresAt: seconds() + CHALLENGE_SECONDS,
    });
    return options;
  }

  /** Keep a new passkey, once its attestation checks out against a challenge this object issued and has not used. */
  async register(
    rp: RelyingParty,
    response: RegistrationResponseJSON,
    label: string
  ): Promise<AccountOutcome<{ readonly passkey: PasskeyRecord }>> {
    if (this.person() === null) {
      return { ok: false, reason: "removed" };
    }
    const challenge = clientChallenge(response.response.clientDataJSON);
    const key = `registration:${challenge ?? ""}`;
    const issued = v.safeParse(ExpirySchema, this.kv.get(key));
    // Spent now, whatever happens next: a challenge is good for one attempt.
    this.kv.delete(key);
    if (
      challenge === null ||
      !issued.success ||
      issued.output.expiresAt <= seconds()
    ) {
      return { ok: false, reason: "challenge" };
    }
    const { verifyRegistrationResponse } = await webauthn();
    let verified: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
    try {
      verified = await verifyRegistrationResponse({
        expectedChallenge: challenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.id,
        requireUserVerification: true,
        response,
      });
    } catch {
      return { ok: false, reason: "verification" };
    }
    if (!verified.verified) {
      return { ok: false, reason: "verification" };
    }
    const { credential } = verified.registrationInfo;
    const record: Credential = {
      counter: credential.counter,
      createdAt: now(),
      id: credential.id,
      label: label.trim().slice(0, 64) || "Passkey",
      lastUsedAt: null,
      publicKey: new Uint8Array(credential.publicKey),
      transports: [...(credential.transports ?? [])],
    };
    this.kv.put(`credential:${record.id}`, record);
    return {
      ok: true,
      passkey: {
        createdAt: record.createdAt,
        id: record.id,
        label: record.label,
        lastUsedAt: null,
      },
    };
  }

  /**
   * Check an assertion made with one of this account's passkeys. `challenge` is the one the Worker issued this
   * browser (its signed cookie); it may be used once here. The signature counter must grow, unless the
   * authenticator keeps none (it reports 0 every time).
   */
  async authenticate(
    rp: RelyingParty,
    response: AuthenticationResponseJSON,
    challenge: string,
    challengeExpiresAt: number
  ): Promise<AccountOutcome<{ readonly person: Person }>> {
    const person = this.person();
    if (person === null) {
      return { ok: false, reason: "removed" };
    }
    // Nothing is written for an assertion that does not check out: an unknown passkey, or a bad signature, leaves
    // this object as it was, so a stranger with free challenges cannot fill it.
    if (this.kv.get(`used:${challenge}`) !== undefined) {
      return { ok: false, reason: "challenge" };
    }
    const stored = v.safeParse(
      CredentialSchema,
      this.kv.get(`credential:${response.id}`)
    );
    if (!stored.success) {
      return { ok: false, reason: "unknown-passkey" };
    }
    const credential = stored.output;
    const { verifyAuthenticationResponse } = await webauthn();
    let verified: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
    try {
      verified = await verifyAuthenticationResponse({
        credential: {
          counter: credential.counter,
          id: credential.id,
          publicKey: credential.publicKey,
          transports: credential.transports,
        },
        expectedChallenge: challenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.id,
        requireUserVerification: true,
        response,
      });
    } catch (error) {
      return {
        ok: false,
        reason: String(error).includes("counter") ? "counter" : "verification",
      };
    }
    if (!verified.verified) {
      return { ok: false, reason: "verification" };
    }
    // Spent now, in one synchronous step with the check: of two assertions racing with one challenge, one wins.
    if (this.kv.get(`used:${challenge}`) !== undefined) {
      return { ok: false, reason: "challenge" };
    }
    this.prune();
    this.kv.put(`used:${challenge}`, { expiresAt: challengeExpiresAt });
    // The counter is read again after the await: another assertion may have moved it meanwhile.
    const current = v.safeParse(
      CredentialSchema,
      this.kv.get(`credential:${credential.id}`)
    );
    if (!current.success) {
      return { ok: false, reason: "unknown-passkey" };
    }
    const { newCounter } = verified.authenticationInfo;
    if (
      (newCounter > 0 || current.output.counter > 0) &&
      newCounter <= current.output.counter
    ) {
      return { ok: false, reason: "counter" };
    }
    this.kv.put(`credential:${credential.id}`, {
      ...current.output,
      counter: newCounter,
      lastUsedAt: now(),
    });
    return { ok: true, person };
  }

  renamePasskey(id: string, label: string): boolean {
    const stored = v.safeParse(
      CredentialSchema,
      this.kv.get(`credential:${id}`)
    );
    const trimmed = label.trim().slice(0, 64);
    if (!stored.success || trimmed === "") {
      return false;
    }
    this.kv.put(`credential:${id}`, { ...stored.output, label: trimmed });
    return true;
  }

  /** Remove a passkey. The last one goes only when `allowLast` says the person knows they will need a link back in. */
  removePasskey(id: string, allowLast: boolean): AccountOutcome<object> {
    const credentials = this.credentials();
    if (!credentials.some((credential) => credential.id === id)) {
      return { ok: false, reason: "unknown-passkey" };
    }
    if (credentials.length === 1 && !allowLast) {
      return { ok: false, reason: "last-passkey" };
    }
    this.kv.delete(`credential:${id}`);
    return { ok: true };
  }

  // --- Sign-in links -----------------------------------------------------------------------------------------------

  /** Keep a sign-in link, by its token's hash, until `expiresAt` (seconds). */
  createLink(hash: string, expiresAt: number): boolean {
    if (this.person() === null) {
      return false;
    }
    this.prune();
    this.kv.put(`link:${hash}`, { expiresAt });
    return true;
  }

  /** Whom a sign-in link opens, without using it: for the page that asks before switching accounts. */
  linkPerson(hash: string): Person | null {
    const stored = v.safeParse(ExpirySchema, this.kv.get(`link:${hash}`));
    if (!stored.success || stored.output.expiresAt <= seconds()) {
      return null;
    }
    return this.person();
  }

  /** Use a sign-in link: once, before it expires. The account's person, or `null`. */
  redeemLink(hash: string): Person | null {
    const key = `link:${hash}`;
    const stored = v.safeParse(ExpirySchema, this.kv.get(key));
    this.kv.delete(key);
    if (!stored.success || stored.output.expiresAt <= seconds()) {
      return null;
    }
    return this.person();
  }

  // --- CLI keys ----------------------------------------------------------------------------------------------------

  /** Whether `person` is this account's, as it is now: the owner and a GitHub account always are; a person until removed. */
  private holds(person: Person): boolean {
    if (person.id.startsWith("person:")) {
      return this.person()?.id === person.id;
    }
    return person.id === OWNER_PRINCIPAL || person.id.startsWith("github:");
  }

  private cliKeyRecords(): { readonly hash: string; readonly key: CliKey }[] {
    const found: { readonly hash: string; readonly key: CliKey }[] = [];
    for (const [name, value] of this.kv.list({ prefix: "cli:" })) {
      const parsed = v.safeParse(CliKeySchema, value);
      if (parsed.success) {
        found.push({ hash: name.slice("cli:".length), key: parsed.output });
      }
    }
    return found;
  }

  /**
   * Keep a CLI key, by its hash, for `person`, who approved it in the browser. `null` when the account is not
   * `person`'s, or was removed.
   */
  createCliKey(input: {
    readonly hash: string;
    readonly name: string;
    readonly person: Person;
    readonly prefix: string;
  }): CliKeyRecord | null {
    if (input.person.id === OWNER_PRINCIPAL) {
      this.ensure({ id: OWNER_PRINCIPAL, name: "Owner" });
    }
    if (!this.holds(input.person)) {
      return null;
    }
    const record: CliKey = {
      createdAt: now(),
      id: crypto.randomUUID(),
      lastUsedAt: null,
      name: input.name.trim().slice(0, 64) || "CLI",
      person: { id: input.person.id, name: input.person.name.slice(0, 64) },
      prefix: input.prefix,
    };
    this.kv.put(`cli:${input.hash}`, record);
    return cliKeyRecord(record);
  }

  /**
   * Whom a CLI key acts as, by its hash: the account's person, as they are now, or `null` for a key this account does
   * not hold or an account the owner removed. Asked on every request, so a revoked key fails at once.
   */
  resolveCliKey(hash: string): Person | null {
    const stored = v.safeParse(CliKeySchema, this.kv.get(`cli:${hash}`));
    if (!stored.success || !this.holds(stored.output.person)) {
      return null;
    }
    const used = now();
    if (stored.output.lastUsedAt?.slice(0, 16) !== used.slice(0, 16)) {
      this.kv.put(`cli:${hash}`, { ...stored.output, lastUsedAt: used });
    }
    return stored.output.person.id.startsWith("github:")
      ? stored.output.person
      : (this.person() ?? stored.output.person);
  }

  /** The CLI keys this account holds, oldest first. */
  cliKeys(): CliKeyRecord[] {
    return this.cliKeyRecords()
      .map(({ key }) => cliKeyRecord(key))
      .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Revoke a CLI key by its id. It fails on the next request, on every surface. */
  revokeCliKey(id: string): boolean {
    const found = this.cliKeyRecords().find(({ key }) => key.id === id);
    if (found === undefined) {
      return false;
    }
    this.kv.delete(`cli:${found.hash}`);
    return true;
  }
}

function cliKeyRecord(key: CliKey): CliKeyRecord {
  return {
    createdAt: key.createdAt,
    id: key.id,
    lastUsedAt: key.lastUsedAt,
    name: key.name,
    prefix: key.prefix,
  };
}
