import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import {
  ApiError,
  AuthenticationError,
  ConnectionError,
  InvalidRequestError,
  Paymentsnp,
  PaymentsnpError,
  PermissionError,
  RateLimitError,
} from "../dist/esm/index.js";
import { apiError, json, noSleep, stubFetch } from "./helpers.mjs";

const KEY = "np_test_abc123";
const client = (stub, extra = {}) =>
  new Paymentsnp({ apiKey: KEY, fetch: stub.fetch, sleep: async () => {}, ...extra });

test("constructor validates the key and derives the environment", () => {
  assert.throws(() => new Paymentsnp({ apiKey: "sk_test_x" }), PaymentsnpError);
  assert.throws(() => new Paymentsnp({ apiKey: "" }), /np_test_/);
  assert.equal(new Paymentsnp({ apiKey: KEY }).environment, "test");
  const live = new Paymentsnp({ apiKey: "np_live_x" });
  assert.equal(live.environment, "live");
  assert.equal(live.baseUrl, "https://api.paymentnp.com/v1");
  // The key never shows up when the client is serialised or inspected.
  assert.ok(!JSON.stringify(live).includes("np_live_x"));
  assert.ok(!Object.values(live).some((v) => v === "np_live_x"));
});

test("CommonJS build exposes the same API", () => {
  const cjs = createRequire(import.meta.url)("../dist/cjs/index.js");
  assert.equal(typeof cjs.Paymentsnp, "function");
  assert.equal(cjs.default, cjs.Paymentsnp);
  assert.equal(typeof cjs.webhooks.constructEvent, "function");
  assert.equal(cjs.toPaisa("15"), 1500);
});

// [call, expected method, expected path, expected query, expected body]
const routes = [
  [(c) => c.checkout.sessions.retrieve("s1"), "GET", "/v1/checkout/sessions/s1"],
  [(c) => c.checkout.sessions.expire("s 1"), "POST", "/v1/checkout/sessions/s%201/expire"],
  [(c) => c.payments.list({ limit: 5, provider: "esewa", search: undefined }), "GET", "/v1/payments", { limit: "5", provider: "esewa" }],
  [(c) => c.payments.retrieve("p1"), "GET", "/v1/payments/p1"],
  [(c) => c.payments.summary(), "GET", "/v1/payments/summary"],
  [(c) => c.invoices.list({ status: "overdue" }), "GET", "/v1/invoices", { status: "overdue" }],
  [(c) => c.invoices.retrieve("i1"), "GET", "/v1/invoices/i1"],
  [(c) => c.invoices.create({ customer: { email: "a@b.np" }, line_items: [{ description: "x", quantity: 1, unit_amount_minor: 100 }] }), "POST", "/v1/invoices", {}, { customer: { email: "a@b.np" }, line_items: [{ description: "x", quantity: 1, unit_amount_minor: 100 }] }],
  [(c) => c.invoices.update("i1", { customer_id: "c1", line_items: [] }), "PATCH", "/v1/invoices/i1", {}, { customer_id: "c1", line_items: [] }],
  [(c) => c.invoices.finalize("i1"), "POST", "/v1/invoices/i1/finalize"],
  [(c) => c.invoices.send("i1", { channels: ["sms"] }), "POST", "/v1/invoices/i1/send", {}, { channels: ["sms"] }],
  [(c) => c.invoices.markPaid("i1", { note: "cash" }), "POST", "/v1/invoices/i1/mark-paid", {}, { note: "cash" }],
  [(c) => c.invoices.void("i1"), "POST", "/v1/invoices/i1/void"],
  [(c) => c.invoices.markUncollectible("i1"), "POST", "/v1/invoices/i1/uncollectible"],
  [(c) => c.invoices.duplicate("i1"), "POST", "/v1/invoices/i1/duplicate"],
  [(c) => c.reconciliation.list({ offset: 10 }), "GET", "/v1/reconciliation", { offset: "10" }],
  [(c) => c.reconciliation.report({ period: 7 }), "GET", "/v1/reconciliation/report", { period: "7" }],
  [(c) => c.reconciliation.import({ provider: "khalti", settlement_reference: "S1", provider_transaction_id: "T1", settled_amount_minor: 100, settled_at: "2026-10-01T00:00:00+05:45" }), "POST", "/v1/reconciliation/import", {}, { provider: "khalti", settlement_reference: "S1", provider_transaction_id: "T1", settled_amount_minor: 100, settled_at: "2026-10-01T00:00:00+05:45" }],
  [(c) => c.reconciliation.importBulk({ records: [] }), "POST", "/v1/reconciliation/import/bulk", {}, { records: [] }],
];

for (const [call, method, path, query = {}, body] of routes)
  test(`${method} ${path}`, async () => {
    const stub = stubFetch(json({ ok: true }));
    assert.deepEqual(await call(client(stub)), { ok: true });
    const [sent] = stub.calls;
    assert.equal(sent.method, method);
    assert.equal(sent.url.pathname, path);
    assert.deepEqual(Object.fromEntries(sent.url.searchParams), query);
    assert.deepEqual(sent.body, body);
    assert.equal(sent.headers.Authorization, `Bearer ${KEY}`);
    assert.equal(sent.headers["User-Agent"], "paymentsnp-node/1.0.0");
    assert.equal(sent.headers["Content-Type"], body ? "application/json" : undefined);
    assert.equal(sent.headers["Idempotency-Key"], undefined);
  });

test("checkout create sends a generated Idempotency-Key and reuses it on retry", async () => {
  const stub = stubFetch(apiError(503, "internal_error"), json({ id: "s1", checkout_url: "https://x/c/t" }, 201));
  const params = { order_id: "ORD-1", amount_minor: 150000, currency: "NPR", success_url: "https://shop.np/ok" };
  const session = await client(stub).checkout.sessions.create(params);
  assert.equal(session.checkout_url, "https://x/c/t");
  assert.equal(stub.calls.length, 2);
  const [first, second] = stub.calls;
  assert.equal(first.method, "POST");
  assert.equal(first.url.pathname, "/v1/checkout/sessions");
  assert.deepEqual(first.body, params);
  assert.match(first.headers["Idempotency-Key"], /^[0-9a-f-]{36}$/);
  assert.equal(second.headers["Idempotency-Key"], first.headers["Idempotency-Key"]);
  // A new call gets a new key.
  const again = stubFetch(json({}));
  await client(again).checkout.sessions.create(params);
  assert.notEqual(again.calls[0].headers["Idempotency-Key"], first.headers["Idempotency-Key"]);
});

test("checkout create honours a caller idempotency key", async () => {
  const stub = stubFetch(json({}));
  await client(stub).checkout.sessions.create({ order_id: "o", amount_minor: 1, currency: "NPR" }, { idempotencyKey: "order-o" });
  assert.equal(stub.calls[0].headers["Idempotency-Key"], "order-o");
});

test("invoice pdf returns bytes", async () => {
  const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
  const stub = stubFetch(new Response(pdf, { headers: { "content-type": "application/pdf" } }));
  const out = await client(stub).invoices.pdf("i1");
  assert.ok(out instanceof Uint8Array);
  assert.deepEqual([...out], [...pdf]);
  assert.equal(stub.calls[0].url.pathname, "/v1/invoices/i1/pdf");
  assert.equal(stub.calls[0].headers.Accept, "application/pdf");
});

test("baseUrl override and trailing slash", async () => {
  const stub = stubFetch(json({}));
  await client(stub, { baseUrl: "http://localhost:4000/v1/" }).payments.list();
  assert.equal(stub.calls[0].url.href, "http://localhost:4000/v1/payments");
});

const errorCases = [
  [400, "invalid_request", InvalidRequestError],
  [401, "api_key_expired", AuthenticationError],
  [403, "insufficient_scope", PermissionError],
  [403, "api_key_ip_denied", PermissionError],
  [404, "not_found", InvalidRequestError],
  [409, "idempotency_conflict", InvalidRequestError],
  [422, "unprocessable", InvalidRequestError],
  [429, "rate_limited", RateLimitError],
  [500, "internal_error", ApiError],
  [418, "teapot", PaymentsnpError],
];
for (const [status, code, Class] of errorCases)
  test(`HTTP ${status} ${code} maps to ${Class.name}`, async () => {
    const stub = stubFetch(apiError(status, code, "Message.", { "retry-after": "7" }));
    const error = await client(stub, { maxRetries: 0 }).payments.retrieve("p").catch((e) => e);
    assert.ok(error instanceof Class);
    assert.ok(error instanceof PaymentsnpError);
    assert.equal(error.name, Class.name);
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    assert.equal(error.message, "Message.");
    assert.equal(error.requestId, "req_err");
    assert.equal(error.retryAfter, 7);
  });

test("non-JSON error body still maps by status", async () => {
  const stub = stubFetch(new Response("<html>502</html>", { status: 502, headers: { "x-request-id": "r9" } }));
  const error = await client(stub, { maxRetries: 0 }).payments.list().catch((e) => e);
  assert.ok(error instanceof ApiError);
  assert.equal(error.code, "http_502");
  assert.equal(error.requestId, "r9");
});

test("GET retries 5xx and network errors with backoff, then succeeds", async () => {
  const { waits, sleep } = noSleep();
  const stub = stubFetch(new TypeError("fetch failed"), apiError(500, "internal_error"), json({ data: [] }));
  const out = await client(stub, { sleep }).payments.list();
  assert.deepEqual(out, { data: [] });
  assert.equal(stub.calls.length, 3);
  assert.equal(waits.length, 2);
  assert.ok(waits[0] >= 250 && waits[0] <= 500, `first wait ${waits[0]}`);
  assert.ok(waits[1] >= 500 && waits[1] <= 1000, `second wait ${waits[1]}`);
});

test("429 honours Retry-After, capped at 60s", async () => {
  const { waits, sleep } = noSleep();
  const stub = stubFetch(apiError(429, "rate_limited", "Slow.", { "retry-after": "3" }), apiError(429, "rate_limited", "Slow.", { "retry-after": "600" }), json({}));
  await client(stub, { sleep }).payments.summary();
  assert.deepEqual(waits, [3000, 60000]);
});

test("gives up after maxRetries and throws the last error", async () => {
  const stub = stubFetch(apiError(503, "internal_error"));
  const error = await client(stub, { maxRetries: 2 }).payments.list().catch((e) => e);
  assert.ok(error instanceof ApiError);
  assert.equal(stub.calls.length, 3);
});

test("4xx is never retried", async () => {
  const stub = stubFetch(apiError(400, "invalid_request"));
  await assert.rejects(client(stub).payments.list(), InvalidRequestError);
  assert.equal(stub.calls.length, 1);
});

test("POST without idempotencyKey is never retried", async () => {
  const stub = stubFetch(new TypeError("fetch failed"));
  await assert.rejects(client(stub).invoices.finalize("i1"), ConnectionError);
  assert.equal(stub.calls.length, 1);
  const stub5 = stubFetch(apiError(500, "internal_error"));
  await assert.rejects(client(stub5).invoices.create({ customer_id: "c", line_items: [] }), ApiError);
  assert.equal(stub5.calls.length, 1);
});

test("POST with idempotencyKey retries connection errors only", async () => {
  const stub = stubFetch(new TypeError("ECONNREFUSED"), json({ id: "i1" }));
  assert.deepEqual(await client(stub).invoices.finalize("i1", { idempotencyKey: "k1" }), { id: "i1" });
  assert.equal(stub.calls.length, 2);
  assert.equal(stub.calls[1].headers["Idempotency-Key"], "k1");
  const stub5 = stubFetch(apiError(500, "internal_error"));
  await assert.rejects(client(stub5).invoices.finalize("i1", { idempotencyKey: "k1" }), ApiError);
  assert.equal(stub5.calls.length, 1);
});

test("timeouts raise ConnectionError(timeout)", async () => {
  const hang = (call) =>
    new Promise((_, reject) => call.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
  const stub = stubFetch(hang);
  const error = await client(stub, { timeoutMs: 20, maxRetries: 1 }).payments.list().catch((e) => e);
  assert.ok(error instanceof ConnectionError);
  assert.equal(error.code, "timeout");
  assert.equal(error.status, 0);
  assert.equal(stub.calls.length, 2); // GET retries timeouts
  // A POST with an idempotency key does not retry a timeout (it may have run).
  const post = stubFetch(hang);
  await assert.rejects(client(post, { timeoutMs: 20 }).invoices.void("i1", { idempotencyKey: "k" }), ConnectionError);
  assert.equal(post.calls.length, 1);
});
