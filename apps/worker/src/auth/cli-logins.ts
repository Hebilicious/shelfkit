/**
 * One Durable Object per pending `shelfkit login` through the browser, named by its user code (`cli.ts`). It holds a
 * single record, `login`, in the object's key-value storage, so it has no SQL schema to migrate:
 *
 * - the device name the CLI sent, to show on the approval page;
 * - the SHA-256 of the device code's secret, which only the CLI that started the login holds;
 * - when it expires (`CLI_LOGIN_SECONDS` after it started);
 * - its state: waiting, denied, or approved, and once approved, the key for the CLI's one pickup and the account
 *   that holds it.
 *
 * The key is handed out once: the poll that reads it deletes the record in the same synchronous step. A login that
 * expires, or that is denied and polled, is deleted too, and the object's alarm deletes whatever is left at expiry,
 * revoking a key approved for a CLI that never came back for it. Every check reads and writes before any `await`, so
 * two requests racing on one login cannot both succeed.
 */
import { DurableObject } from "cloudflare:workers";
import * as v from "valibot";

import { sameHash } from "./keys.ts";
import { accountStub } from "./principals.ts";

const LoginSchema = v.object({
  device: v.string(),
  expiresAt: v.number(),
  secretHash: v.string(),
  state: v.variant("status", [
    v.object({ status: v.literal("pending") }),
    v.object({ status: v.literal("denied") }),
    v.object({
      key: v.string(),
      keyId: v.string(),
      principal: v.string(),
      status: v.literal("approved"),
    }),
  ]),
});

type Login = v.InferOutput<typeof LoginSchema>;

/** What the CLI's poll learns. A wrong secret learns what an unknown or expired code does. */
export type CliLoginPoll =
  | { readonly status: "pending" }
  | { readonly status: "denied" }
  | { readonly status: "expired" }
  | { readonly status: "approved"; readonly key: string };

/** A login waiting for approval, as the approval page shows it. */
export interface PendingCliLogin {
  readonly device: string;
  readonly expiresAt: number;
}

function seconds(): number {
  return Math.floor(Date.now() / 1000);
}

export class CliLoginIndex extends DurableObject<Env> {
  private get kv(): SyncKvStorage {
    return this.ctx.storage.kv;
  }

  /** The login, or `null` when there is none. An expired one is still returned: callers check `expiresAt`. */
  private login(): Login | null {
    const found = v.safeParse(LoginSchema, this.kv.get("login"));
    return found.success ? found.output : null;
  }

  private live(): Login | null {
    const login = this.login();
    return login === null || login.expiresAt <= seconds() ? null : login;
  }

  /** Forget the login. An approved key nobody picked up is revoked, so no key exists that no CLI holds. */
  private async end(login: Login | null): Promise<void> {
    this.kv.delete("login");
    await this.ctx.storage.deleteAlarm();
    if (login?.state.status === "approved") {
      await accountStub(this.env, login.state.principal).revokeCliKey(
        login.state.keyId
      );
    }
  }

  /** Start a login. `false` when this code already names a live one, so the caller picks another code. */
  async begin(input: {
    readonly device: string;
    readonly secretHash: string;
    readonly expiresAt: number;
  }): Promise<boolean> {
    if (this.live() !== null) {
      return false;
    }
    const login: Login = { ...input, state: { status: "pending" } };
    this.kv.put("login", login);
    await this.ctx.storage.setAlarm(input.expiresAt * 1000);
    return true;
  }

  /** The login, while it waits for approval; `null` once it was approved, denied, or expired, or for none. */
  pending(): PendingCliLogin | null {
    const login = this.live();
    return login?.state.status === "pending"
      ? { device: login.device, expiresAt: login.expiresAt }
      : null;
  }

  /** Approve a waiting login with `key`, which the account `principal` holds as `keyId`. `false` if it is not waiting. */
  approve(input: {
    readonly key: string;
    readonly keyId: string;
    readonly principal: string;
  }): boolean {
    const login = this.live();
    if (login?.state.status !== "pending") {
      return false;
    }
    this.kv.put("login", {
      ...login,
      state: { ...input, status: "approved" },
    } satisfies Login);
    return true;
  }

  /** Deny a waiting login. `false` if it is not waiting. */
  deny(): boolean {
    const login = this.live();
    if (login?.state.status !== "pending") {
      return false;
    }
    this.kv.put("login", {
      ...login,
      state: { status: "denied" },
    } satisfies Login);
    return true;
  }

  /**
   * The CLI asks how its login stands, with the hash of its device code's secret. An approved key is handed out here
   * once: the record goes in the same step that reads it.
   */
  async poll(secretHash: string): Promise<CliLoginPoll> {
    const login = this.login();
    if (login === null || !sameHash(login.secretHash, secretHash)) {
      return { status: "expired" };
    }
    if (login.expiresAt <= seconds()) {
      await this.end(login);
      return { status: "expired" };
    }
    const { state } = login;
    if (state.status === "pending") {
      return { status: "pending" };
    }
    // Spent now, before any await: a second poll finds nothing.
    this.kv.delete("login");
    await this.ctx.storage.deleteAlarm();
    return state.status === "approved"
      ? { key: state.key, status: "approved" }
      : { status: "denied" };
  }

  /** At expiry: whatever is left goes. */
  override async alarm(): Promise<void> {
    const login = this.login();
    if (login !== null && login.expiresAt > seconds()) {
      await this.ctx.storage.setAlarm(login.expiresAt * 1000);
      return;
    }
    await this.end(login);
  }
}
