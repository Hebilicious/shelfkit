/**
 * Load the WebAuthn library before a test file's first test. The Worker imports it on first use, from inside the
 * account's Durable Object (`src/auth/accounts.ts`). In the Workers Vitest pool, with many test files running at once
 * on the local Artifacts simulator, that first import from inside a Durable Object never settled, so every passkey
 * test after it timed out; imported here, outside any object, it is already loaded when the object asks for it.
 */
import "@simplewebauthn/server";
