/**
 * A software passkey authenticator, for tests only: it makes and uses ES256 passkeys the way a platform
 * authenticator does, so the Worker's ceremonies run against real attestation and assertion bytes. It speaks the
 * JSON WebAuthn browsers hand a page (what `@simplewebauthn/browser` sends), and can be told to lie (another origin,
 * another relying party, a counter that goes backwards) so tests can watch the Worker refuse.
 */

const encoder = new TextEncoder();

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(
    atob(text.replaceAll("-", "+").replaceAll("_", "/")),
    (char) => char.codePointAt(0) ?? 0
  );
}

function concat(...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(
    parts.reduce((size, part) => size + part.length, 0)
  );
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))
  );
}

/** A CBOR value, as far as attestation objects and COSE keys need, tagged by its major type. */
type Cbor =
  | { readonly int: number }
  | { readonly text: string }
  | { readonly bytes: Uint8Array }
  | { readonly map: readonly (readonly [Cbor, Cbor])[] };

function head(major: number, length: number): Uint8Array {
  if (length < 24) {
    return new Uint8Array([major * 32 + length]);
  }
  if (length < 256) {
    return new Uint8Array([major * 32 + 24, length]);
  }
  return new Uint8Array([
    major * 32 + 25,
    Math.floor(length / 256),
    length % 256,
  ]);
}

function cbor(value: Cbor): Uint8Array {
  if ("int" in value) {
    return value.int >= 0 ? head(0, value.int) : head(1, -1 - value.int);
  }
  if ("text" in value) {
    const bytes = encoder.encode(value.text);
    return concat(head(3, bytes.length), bytes);
  }
  if ("bytes" in value) {
    return concat(head(2, value.bytes.length), value.bytes);
  }
  return concat(
    head(5, value.map.length),
    ...value.map.flatMap(([key, item]) => [cbor(key), cbor(item)])
  );
}

const int = (value: number): Cbor => ({ int: value });
const text = (value: string): Cbor => ({ text: value });
const byteString = (value: Uint8Array): Cbor => ({ bytes: value });

/** An ECDSA signature in the DER form WebAuthn wants, from WebCrypto's raw `r || s`. */
function der(raw: Uint8Array): Uint8Array {
  const integer = (bytes: Uint8Array) => {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) {
      start += 1;
    }
    const trimmed = bytes.slice(start);
    const padded =
      (trimmed[0] ?? 0) >= 0x80
        ? concat(new Uint8Array([0]), trimmed)
        : trimmed;
    return concat(new Uint8Array([0x02, padded.length]), padded);
  };
  const body = concat(integer(raw.slice(0, 32)), integer(raw.slice(32)));
  return concat(new Uint8Array([0x30, body.length]), body);
}

export interface Ceremony {
  /** The origin the browser reports; the deployment's unless a test lies. */
  readonly origin: string;
  /** The relying party the authenticator signs for; the deployment's hostname unless a test lies. */
  readonly rpId?: string;
}

interface Passkey {
  readonly id: Uint8Array<ArrayBuffer>;
  readonly keys: CryptoKeyPair;
  readonly userHandle: string;
  counter: number;
}

const FLAGS = { attested: 0x40, present: 0x01, verified: 0x04 };

/** One device's authenticator, holding the passkeys it made. */
export class Authenticator {
  readonly passkeys: Passkey[] = [];
  /** Added to the counter on each assertion; 0 makes the counter stand still, as a counterless authenticator's does. */
  step = 1;

  /** `navigator.credentials.create()`, from the options the Worker sent. The JSON the page posts back. */
  async create(
    options: {
      readonly challenge: string;
      readonly rp: { readonly id?: string };
      readonly user: { readonly id: string };
    },
    ceremony: Ceremony
  ) {
    const keys = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"]
    );
    const raw = new Uint8Array(
      await crypto.subtle.exportKey("raw", keys.publicKey)
    );
    const id = crypto.getRandomValues(new Uint8Array(32));
    const passkey: Passkey = {
      counter: 0,
      id,
      keys,
      userHandle: options.user.id,
    };
    const rpId =
      ceremony.rpId ?? options.rp.id ?? new URL(ceremony.origin).hostname;
    const coseKey = cbor({
      map: [
        [int(1), int(2)],
        [int(3), int(-7)],
        [int(-1), int(1)],
        [int(-2), byteString(raw.slice(1, 33))],
        [int(-3), byteString(raw.slice(33, 65))],
      ],
    });
    const authData = concat(
      await sha256(encoder.encode(rpId)),
      new Uint8Array([FLAGS.present + FLAGS.verified + FLAGS.attested]),
      new Uint8Array([0, 0, 0, 0]),
      new Uint8Array(16),
      new Uint8Array([0, id.length]),
      id,
      coseKey
    );
    const attestationObject = cbor({
      map: [
        [text("fmt"), text("none")],
        [text("attStmt"), { map: [] }],
        [text("authData"), byteString(authData)],
      ],
    });
    const clientData = encoder.encode(
      JSON.stringify({
        challenge: options.challenge,
        crossOrigin: false,
        origin: ceremony.origin,
        type: "webauthn.create",
      })
    );
    this.passkeys.push(passkey);
    return {
      authenticatorAttachment: "platform",
      clientExtensionResults: {},
      id: base64url(id),
      rawId: base64url(id),
      response: {
        attestationObject: base64url(attestationObject),
        clientDataJSON: base64url(clientData),
        transports: ["internal"],
      },
      type: "public-key",
    };
  }

  /** `navigator.credentials.get()` with the first passkey it holds (or `passkey`), for the Worker's options. */
  async get(
    options: { readonly challenge: string; readonly rpId?: string },
    ceremony: Ceremony,
    passkey: Passkey | undefined = this.passkeys[0]
  ) {
    if (passkey === undefined) {
      throw new Error("this authenticator holds no passkey");
    }
    passkey.counter += this.step;
    const rpId =
      ceremony.rpId ?? options.rpId ?? new URL(ceremony.origin).hostname;
    const counter = new Uint8Array(4);
    new DataView(counter.buffer).setUint32(0, passkey.counter);
    const authData = concat(
      await sha256(encoder.encode(rpId)),
      new Uint8Array([FLAGS.present + FLAGS.verified]),
      counter
    );
    const clientData = encoder.encode(
      JSON.stringify({
        challenge: options.challenge,
        crossOrigin: false,
        origin: ceremony.origin,
        type: "webauthn.get",
      })
    );
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        { hash: "SHA-256", name: "ECDSA" },
        passkey.keys.privateKey,
        concat(authData, await sha256(clientData))
      )
    );
    return {
      authenticatorAttachment: "platform",
      clientExtensionResults: {},
      id: base64url(passkey.id),
      rawId: base64url(passkey.id),
      response: {
        authenticatorData: base64url(authData),
        clientDataJSON: base64url(clientData),
        signature: base64url(der(signature)),
        userHandle: passkey.userHandle,
      },
      type: "public-key",
    };
  }
}
