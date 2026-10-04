import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import {
  Paymentsnp,
  SignatureVerificationError,
  constructEvent,
  formatNpr,
  generateTestHeader,
  toPaisa,
  verifySignature,
  webhooks,
} from "../dist/esm/index.js";

const secret = "whsec_test_secret";
const event = {
  id: "8d3c0a52-0000-4000-8000-000000000001",
  type: "payment.succeeded",
  api_version: "v1",
  environment: "test",
  created_at: "2026-10-04T00:00:00.000Z",
  data: { payment_id: "p1", order_id: "ORD-1", amount_minor: 150000, currency: "NPR", is_simulated: true },
};
const body = JSON.stringify(event);
const now = 1_780_000_000;
// Exactly how backend/src/webhooks/webhook.service.ts signs.
const serverHeader = (t, raw = body, key = secret) =>
  `t=${t},v1=${createHmac("sha256", key).update(`${t}.${raw}`).digest("hex")}`;

test("constructEvent accepts a server-signed body (string and bytes)", async () => {
  const header = serverHeader(now);
  assert.deepEqual(await constructEvent(body, header, secret, { now }), event);
  assert.deepEqual(await Paymentsnp.webhooks.constructEvent(new TextEncoder().encode(body), header, secret, { now }), event);
  assert.equal(await verifySignature(body, header, secret, { now }), true);
});

test("generateTestHeader matches the server signature", async () => {
  assert.equal(await generateTestHeader(body, secret, now), serverHeader(now));
  assert.equal(webhooks.generateTestHeader, generateTestHeader);
});

test("rejects tampered body, wrong secret and garbage", async () => {
  const header = serverHeader(now);
  const reject = (promise, code) =>
    assert.rejects(promise, (e) => e instanceof SignatureVerificationError && e.code === code);
  await reject(constructEvent(body.replace("150000", "1"), header, secret, { now }), "signature_mismatch");
  await reject(constructEvent(body, header, "whsec_other", { now }), "signature_mismatch");
  await reject(constructEvent(body, "", secret, { now }), "missing_signature");
  await reject(constructEvent(body, "v1=abc", secret, { now }), "malformed_signature");
  await reject(constructEvent(body, `t=${now},v1=zz`, secret, { now }), "signature_mismatch");
  await reject(constructEvent(JSON.parse(body), header, secret, { now }), "invalid_body");
});

test("enforces the timestamp tolerance (default 300s, both directions)", async () => {
  await assert.rejects(constructEvent(body, serverHeader(now - 301), secret, { now }), /tolerance/);
  await assert.rejects(constructEvent(body, serverHeader(now + 301), secret, { now }), /tolerance/);
  assert.ok(await constructEvent(body, serverHeader(now - 299), secret, { now }));
  assert.ok(await constructEvent(body, serverHeader(now - 3000), secret, { now, toleranceSeconds: 3600 }));
});

test("any of several v1 signatures may match (secret rotation)", async () => {
  const good = serverHeader(now).split(",")[1];
  const other = serverHeader(now, body, "whsec_old").split(",")[1];
  assert.ok(await constructEvent(body, `t=${now},${other},${good}`, secret, { now }));
  assert.ok(await constructEvent(body, `t=${now}, ${good}, v0=ignored`, secret, { now }));
});

test("toPaisa: string math, no floats", () => {
  const ok = [
    ["1,234.50", 123450], ["1500", 150000], ["1500.00", 150000], ["0.1", 10], ["0.01", 1],
    ["12,34,567.89", 123456789], [" 10 ", 1000], [15, 1500], [19.99, 1999], ["0", 0],
    ["1000000000", 100000000000],
  ];
  for (const [input, expected] of ok) assert.equal(toPaisa(input), expected, String(input));
  for (const bad of ["-1", "1.234", "", "abc", "1,2", "1.", ".5", "1e3", "Rs 10", -5, NaN, Infinity, 0.1 + 0.2, "99999999999999999"])
    assert.throws(() => toPaisa(bad), RangeError, String(bad));
});

test("formatNpr", () => {
  assert.equal(formatNpr(123450), "NPR 1,234.50");
  assert.equal(formatNpr(12345678901), "NPR 123,456,789.01");
  assert.equal(formatNpr(5), "NPR 0.05");
  assert.equal(formatNpr(-150000), "-NPR 1,500.00");
});
