import assert from "node:assert/strict";
import { test } from "node:test";
import { parse, run } from "../dist/esm/cli.js";
import { generateTestHeader } from "../dist/esm/index.js";
import { apiError, json, stubFetch } from "./helpers.mjs";

function io(stub, env = { PAYMENTSNP_API_KEY: "np_test_cli" }, files = {}) {
  const out = { stdout: "", stderr: "" };
  return {
    out,
    io: {
      env,
      fetch: stub?.fetch,
      stdout: (t) => (out.stdout += t),
      stderr: (t) => (out.stderr += t),
      readFile: async (p) => {
        if (!(p in files)) throw new Error(`ENOENT: ${p}`);
        return new TextEncoder().encode(files[p]);
      },
    },
  };
}

test("parse handles flags and positionals", () => {
  const { values, positionals } = parse(["checkout", "create", "--amount", "1500.00", "--order", "ORD-1", "--json"]);
  assert.deepEqual(positionals, ["checkout", "create"]);
  assert.equal(values.amount, "1500.00");
  assert.equal(values.json, true);
  assert.throws(() => parse(["--nope"]));
});

test("checkout create converts rupees to paisa and prints JSON", async () => {
  const stub = stubFetch(json({ id: "s1", checkout_url: "https://paymentnp.com/c/t" }, 201));
  const t = io(stub);
  const code = await run(["checkout", "create", "--amount", "1,500.50", "--order", "ORD-1", "--success-url", "https://shop.np/ok", "--cancel-url", "https://shop.np/no", "--json"], t.io);
  assert.equal(code, 0);
  assert.equal(JSON.parse(t.out.stdout).id, "s1");
  const [call] = stub.calls;
  assert.equal(call.url.pathname, "/v1/checkout/sessions");
  assert.deepEqual(call.body, { order_id: "ORD-1", amount_minor: 150050, currency: "NPR", success_url: "https://shop.np/ok", cancel_url: "https://shop.np/no" });
  assert.ok(call.headers["Idempotency-Key"]);
  assert.equal(call.headers.Authorization, "Bearer np_test_cli");
});

test("checkout get/expire, payments list/get, invoices list", async () => {
  const cases = [
    [["checkout", "get", "s1"], "GET", "/v1/checkout/sessions/s1"],
    [["checkout", "expire", "s1"], "POST", "/v1/checkout/sessions/s1/expire"],
    [["payments", "list", "--limit", "3"], "GET", "/v1/payments?limit=3"],
    [["payments", "get", "p1"], "GET", "/v1/payments/p1"],
    [["invoices", "list", "--status", "open"], "GET", "/v1/invoices?status=open"],
  ];
  for (const [argv, method, path] of cases) {
    const stub = stubFetch(json({ data: [{ id: "x", amount_minor: 150000 }], id: "x" }));
    const t = io(stub);
    assert.equal(await run(argv, t.io), 0, argv.join(" "));
    assert.equal(stub.calls[0].method, method);
    assert.equal(stub.calls[0].url.pathname + stub.calls[0].url.search, path);
  }
});

test("human table output formats amounts", async () => {
  const stub = stubFetch(json({ data: [{ id: "p1", order_id: "ORD-1", provider: "esewa", amount_minor: 150000, provider_transaction_id: "T1", verified_at: "2026-10-01" }] }));
  const t = io(stub);
  await run(["payments", "list"], t.io);
  assert.match(t.out.stdout, /^id\s+order_id\s+provider\s+amount_minor/);
  assert.match(t.out.stdout, /p1\s+ORD-1\s+esewa\s+NPR 1,500\.00\s+T1/);
});

test("API key: required from env, warned when passed as an argument", async () => {
  const missing = io(null, {});
  assert.equal(await run(["payments", "list"], missing.io), 2);
  assert.match(missing.out.stderr, /PAYMENTSNP_API_KEY/);
  const stub = stubFetch(json({ data: [] }));
  const warned = io(stub, {});
  assert.equal(await run(["payments", "list", "--api-key", "np_test_arg"], warned.io), 0);
  assert.match(warned.out.stderr, /shell history/);
  assert.ok(!warned.out.stderr.includes("np_test_arg"));
});

test("API errors exit 1 with code and request id", async () => {
  const t = io(stubFetch(apiError(403, "insufficient_scope", "This API key lacks the required scope.")));
  assert.equal(await run(["payments", "list"], t.io), 1);
  assert.match(t.out.stderr, /PermissionError \(insufficient_scope, HTTP 403\).*req_err/);
});

test("webhooks sign and verify", async () => {
  const body = '{"id":"e1","type":"webhook.test","data":{}}';
  const files = { "body.json": body };
  const signed = io(null, {}, files);
  assert.equal(await run(["webhooks", "sign", "--secret", "whsec_x", "--file", "body.json", "--timestamp", "1700000000"], signed.io), 0);
  const header = signed.out.stdout.trim();
  assert.equal(header, await generateTestHeader(body, "whsec_x", 1700000000));
  const ok = io(null, { PAYMENTSNP_WEBHOOK_SECRET: "whsec_x" }, files);
  assert.equal(await run(["webhooks", "verify", "--header", header, "--file", "body.json"], ok.io), 0);
  assert.match(ok.out.stdout, /Signature valid: webhook\.test e1/);
  const bad = io(null, { PAYMENTSNP_WEBHOOK_SECRET: "whsec_y" }, files);
  assert.equal(await run(["webhooks", "verify", "--header", header, "--file", "body.json"], bad.io), 1);
  assert.match(bad.out.stderr, /SignatureVerificationError/);
});

test("usage errors exit 2", async () => {
  for (const argv of [[], ["nope"], ["checkout", "create", "--order", "x"], ["checkout", "create", "--amount", "1.234", "--order", "x"], ["payments", "list", "--limit", "x"]]) {
    const t = io(stubFetch(json({})));
    const code = await run(argv, t.io);
    assert.ok(code === 2 || code === 1, `${argv.join(" ")} -> ${code}`);
    assert.ok(t.out.stderr || t.out.stdout);
  }
  const help = io(null);
  assert.equal(await run(["--help"], help.io), 0);
  assert.match(help.out.stdout, /paymentsnp checkout create/);
});
