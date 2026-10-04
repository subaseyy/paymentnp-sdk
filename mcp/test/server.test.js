import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer, toPaisa, formatNpr, PROTOCOL_VERSIONS } from "../server.js";

const KEY = "np_test_secretsecretsecret";
const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function stub(responder) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return responder(String(url), init);
  };
  return { fetch, calls };
}
const call = (server, name, args = {}, id = 1) =>
  server.handle({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
const text = (response) => response.result.content[0].text;

test("toPaisa converts NPR strings exactly, without floats", () => {
  assert.equal(toPaisa("1500"), 150000);
  assert.equal(toPaisa("1,500.5"), 150050);
  assert.equal(toPaisa("0.29"), 29);
  assert.equal(toPaisa("Rs 10.01"), 1001);
  assert.equal(toPaisa("NPR 1,00,000.99"), 10000099);
  for (const bad of ["", "abc", "1.234", "-5", "0", "0.00", "1e3", "1234567890"])
    assert.throws(() => toPaisa(bad), new RegExp("Amount"), bad);
  assert.equal(formatNpr(150050), "NPR 1,500.50");
  assert.equal(formatNpr(10000000), "NPR 1,00,000.00");
  assert.equal(formatNpr(5), "NPR 0.05");
});

test("stdio framing: newline-delimited JSON-RPC, logs on stderr only", async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL("../server.js", import.meta.url))], {
    env: { PATH: process.env.PATH, PAYMENTSNP_API_KEY: KEY },
  });
  let out = "", err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  child.stdin.write(
    [
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      "{not json",
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
      "",
    ].join("\n"),
  );
  child.stdin.end();
  await new Promise((resolve) => child.on("close", resolve));
  const lines = out.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 3); // no reply to the notification
  const byId = (id) => lines.find((l) => l.id === id);
  assert.equal(byId(1).result.protocolVersion, "2025-06-18");
  assert.deepEqual(byId(2).result, {});
  assert.equal(byId(null).error.code, -32700);
  assert.match(err, /ready/);
  assert.ok(!out.includes(KEY) && !err.includes(KEY));
});

test("initialize negotiates the version and declares tools", async () => {
  const server = createServer({ PAYMENTSNP_API_KEY: KEY });
  const r = await server.handle({ jsonrpc: "2.0", id: 7, method: "initialize", params: { protocolVersion: "1999-01-01" } });
  assert.equal(r.id, 7);
  assert.equal(r.result.protocolVersion, PROTOCOL_VERSIONS[0]);
  assert.deepEqual(r.result.capabilities, { tools: { listChanged: false } });
  assert.equal(r.result.serverInfo.name, "paymentsnp");
  const unknown = await server.handle({ jsonrpc: "2.0", id: 8, method: "server/discover" });
  assert.equal(unknown.error.code, -32601);
  const invalid = await server.handle({ id: 9, method: "ping" });
  assert.equal(invalid.error.code, -32600);
});

test("tools/list hides write tools unless PAYMENTSNP_MCP_ALLOW_WRITES=true", async () => {
  const names = async (env) =>
    (await createServer(env).handle({ jsonrpc: "2.0", id: 1, method: "tools/list" })).result.tools.map((t) => t.name);
  const readOnly = await names({ PAYMENTSNP_API_KEY: KEY });
  assert.deepEqual(readOnly, [
    "get_checkout_session",
    "list_payments",
    "get_payment",
    "payments_summary",
    "list_invoices",
    "get_invoice",
    "reconciliation_report",
  ]);
  const all = await names({ PAYMENTSNP_API_KEY: KEY, PAYMENTSNP_MCP_ALLOW_WRITES: "true" });
  for (const name of ["create_checkout_session", "expire_checkout_session", "create_invoice_draft", "finalize_invoice", "send_invoice"])
    assert.ok(all.includes(name) && !readOnly.includes(name), name);
  const tools = (await createServer({ PAYMENTSNP_MCP_ALLOW_WRITES: "true" }).handle({ jsonrpc: "2.0", id: 1, method: "tools/list" })).result.tools;
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, "object");
    assert.ok(!("run" in tool) && !("write" in tool));
  }
  // Hidden write tools cannot be called either.
  const hidden = await call(createServer({ PAYMENTSNP_API_KEY: KEY }), "create_checkout_session", { order_id: "a", amount: "1" });
  assert.equal(hidden.error.code, -32602);
});

test("read tool: GET with bearer key, NPR formatting, PII masked", async () => {
  const { fetch, calls } = stub(() =>
    json(200, {
      data: [{ id: "p1", amount_minor: 150050, customer: { name: "Sita", email: "sita@example.com", phone: "9812345678" }, provider_transaction_id: null }],
      has_more: false,
    }),
  );
  const server = createServer({ PAYMENTSNP_API_KEY: KEY, PAYMENTSNP_API_BASE_URL: "http://localhost:4000/v1" }, { fetch });
  const r = await call(server, "list_payments", { limit: 5, provider: "esewa" });
  assert.equal(r.result.isError, false);
  assert.equal(calls[0].url, "http://localhost:4000/v1/payments?limit=5&provider=esewa");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${KEY}`);
  const body = JSON.parse(text(r));
  assert.equal(body.data[0].amount_npr, "NPR 1,500.50");
  assert.equal(body.data[0].amount_minor, 150050);
  assert.equal(body.data[0].customer.email, "s***@example.com");
  assert.equal(body.data[0].customer.phone, "98******78");
  assert.ok(!("provider_transaction_id" in body.data[0]));
  assert.ok(!text(r).includes(KEY));
});

test("create_checkout_session sends paisa, currency and Idempotency-Key", async () => {
  const { fetch, calls } = stub(() =>
    json(201, { id: "s1", status: "open", amount_minor: 150000, checkout_url: "https://paymentnp.com/c/tok", public_session_path: "/v1/checkout/public/tok" }),
  );
  const server = createServer({ PAYMENTSNP_API_KEY: KEY, PAYMENTSNP_MCP_ALLOW_WRITES: "true" }, { fetch });
  const r = await call(server, "create_checkout_session", { order_id: "order-1001", amount: "1,500" });
  assert.equal(r.result.isError, false);
  assert.equal(calls[0].url, "https://api.paymentnp.com/v1/checkout/sessions");
  assert.equal(calls[0].init.headers["Idempotency-Key"], "order-1001");
  assert.deepEqual(JSON.parse(calls[0].init.body), { order_id: "order-1001", amount_minor: 150000, currency: "NPR" });
  const body = JSON.parse(text(r));
  assert.equal(body.checkout_url, "https://paymentnp.com/c/tok");
  assert.ok(!("public_session_path" in body));
});

test("invalid arguments are tool errors and never reach the API", async () => {
  const { fetch, calls } = stub(() => json(200, {}));
  const server = createServer({ PAYMENTSNP_API_KEY: KEY, PAYMENTSNP_MCP_ALLOW_WRITES: "true" }, { fetch });
  for (const [name, args] of [
    ["get_payment", { payment_id: "../admin" }],
    ["get_payment", {}],
    ["list_payments", { limit: 1000 }],
    ["list_payments", { surprise: 1 }],
    ["create_checkout_session", { order_id: "x", amount: "1.234" }],
    ["create_checkout_session", { order_id: "has space", amount: "10" }],
  ]) {
    const r = await call(server, name, args);
    assert.equal(r.result.isError, true, name);
    assert.match(text(r), /^InvalidRequestError/);
  }
  assert.equal(calls.length, 0);
});

test("API errors map to the SDK error classes", async () => {
  const cases = [
    [401, "unauthorized", "AuthenticationError"],
    [403, "insufficient_scope", "PermissionError"],
    [404, "not_found", "InvalidRequestError"],
    [409, "order_conflict", "InvalidRequestError"],
    [429, "rate_limited", "RateLimitError"],
    [500, "internal_error", "ApiError"],
  ];
  for (const [status, code, name] of cases) {
    const { fetch } = stub(() => json(status, { error: { code, message: "Nope.", request_id: "req_1" } }));
    const r = await call(createServer({ PAYMENTSNP_API_KEY: KEY }, { fetch }), "payments_summary");
    assert.equal(r.result.isError, true);
    assert.equal(text(r), `${name} (${status} ${code}): Nope. [request_id req_1]`);
  }
  const down = await call(
    createServer({ PAYMENTSNP_API_KEY: KEY }, { fetch: async () => { throw new TypeError(`fetch failed ${KEY}`); } }),
    "payments_summary",
  );
  assert.match(text(down), /^ConnectionError/);
  assert.ok(!text(down).includes(KEY));
  const noKey = await call(createServer({}), "payments_summary");
  assert.match(text(noKey), /^AuthenticationError: PAYMENTSNP_API_KEY is not set/);
});

test("refuses a non-https base URL except localhost", () => {
  assert.throws(() => createServer({ PAYMENTSNP_API_BASE_URL: "http://api.example.com/v1" }), /https/);
  assert.doesNotThrow(() => createServer({ PAYMENTSNP_API_BASE_URL: "http://127.0.0.1:4000/v1" }));
});
