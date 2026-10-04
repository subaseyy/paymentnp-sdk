// Webhook signatures: `Paymentnp-Signature: t=<unix>,v1=<hex>` where
// hex = HMAC-SHA256(secret, `${t}.${rawBody}`). Web Crypto only, so this
// runs on Node 18+, Bun, Deno and edge runtimes.
import { SignatureVerificationError } from "./errors.js";
import type { WebhookEvent } from "./types.js";

/** Header names as sent by Paymentsnp (the technical prefix is "Paymentnp"). */
export const SIGNATURE_HEADER = "Paymentnp-Signature";
export const EVENT_ID_HEADER = "Paymentnp-Event-Id";

/** @internal */
export async function webCrypto(): Promise<Crypto> {
  if (globalThis.crypto?.subtle) return globalThis.crypto;
  // Node 18 without the global: fall back to node:crypto.
  const node = await import(/* webpackIgnore: true */ "node:crypto");
  return node.webcrypto as unknown as Crypto;
}

const encoder = new TextEncoder();
const bytes = (value: string | Uint8Array) =>
  typeof value === "string" ? encoder.encode(value) : value;

function signedPayload(timestamp: string, body: string | Uint8Array) {
  const prefix = encoder.encode(`${timestamp}.`),
    raw = bytes(body);
  const out = new Uint8Array(prefix.length + raw.length);
  out.set(prefix);
  out.set(raw, prefix.length);
  return out;
}

async function key(secret: string) {
  return (await webCrypto()).subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function fromHex(hex: string) {
  if (!/^[0-9a-f]{64}$/i.test(hex)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export interface VerifyOptions {
  /** Maximum age (and clock skew) of the signature in seconds. Default 300. */
  toleranceSeconds?: number;
  /** Current time in unix seconds (for tests). */
  now?: number;
}

/**
 * Verifies a `Paymentnp-Signature` header against the raw request body.
 * Accepts several `v1=` values (any match passes). Throws
 * SignatureVerificationError; resolves to true on success.
 */
export async function verifySignature(
  rawBody: string | Uint8Array,
  signatureHeader: string | null | undefined,
  secret: string,
  { toleranceSeconds = 300, now }: VerifyOptions = {},
): Promise<true> {
  if (typeof rawBody !== "string" && !(rawBody instanceof Uint8Array))
    throw new SignatureVerificationError(
      "Pass the raw request body (string or bytes), not parsed JSON.",
      { code: "invalid_body" },
    );
  if (!secret)
    throw new SignatureVerificationError("Webhook secret is required.", {
      code: "missing_secret",
    });
  if (!signatureHeader)
    throw new SignatureVerificationError(`Missing ${SIGNATURE_HEADER} header.`, {
      code: "missing_signature",
    });
  let timestamp: string | undefined;
  const signatures: string[] = [];
  for (const part of signatureHeader.split(",")) {
    const at = part.indexOf("=");
    const name = part.slice(0, at).trim(),
      value = part.slice(at + 1).trim();
    if (name === "t") timestamp = value;
    else if (name === "v1") signatures.push(value);
  }
  if (!timestamp || !/^\d{1,12}$/.test(timestamp) || !signatures.length)
    throw new SignatureVerificationError(`Malformed ${SIGNATURE_HEADER} header.`, {
      code: "malformed_signature",
    });
  const current = now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(current - Number(timestamp)) > toleranceSeconds)
    throw new SignatureVerificationError(
      "Webhook timestamp is outside the tolerance window.",
      { code: "timestamp_out_of_tolerance" },
    );
  const crypto = await webCrypto(),
    hmac = await key(secret),
    payload = signedPayload(timestamp, rawBody);
  for (const candidate of signatures) {
    const expected = fromHex(candidate);
    // subtle.verify compares in constant time.
    if (expected && (await crypto.subtle.verify("HMAC", hmac, expected, payload)))
      return true;
  }
  throw new SignatureVerificationError("Webhook signature does not match.", {
    code: "signature_mismatch",
  });
}

/** Verifies the signature, then parses the body into a WebhookEvent. */
export async function constructEvent(
  rawBody: string | Uint8Array,
  signatureHeader: string | null | undefined,
  secret: string,
  options: VerifyOptions = {},
): Promise<WebhookEvent> {
  await verifySignature(rawBody, signatureHeader, secret, options);
  const text =
    typeof rawBody === "string" ? rawBody : new TextDecoder().decode(rawBody);
  try {
    return JSON.parse(text) as WebhookEvent;
  } catch {
    throw new SignatureVerificationError("Webhook body is not valid JSON.", {
      code: "invalid_body",
    });
  }
}

/** Builds a valid `Paymentnp-Signature` header, for tests and local tooling. */
export async function generateTestHeader(
  body: string | Uint8Array,
  secret: string,
  timestamp: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const t = String(Math.floor(timestamp));
  const mac = new Uint8Array(
    await (await webCrypto()).subtle.sign("HMAC", await key(secret), signedPayload(t, body)),
  );
  const hex = Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
  return `t=${t},v1=${hex}`;
}

export const webhooks = {
  constructEvent,
  verifySignature,
  generateTestHeader,
  SIGNATURE_HEADER,
  EVENT_ID_HEADER,
};
