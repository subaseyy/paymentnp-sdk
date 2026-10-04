// Live integration test against a running Paymentsnp API. Skipped unless
// PAYMENTSNP_E2E_BASE_URL and PAYMENTSNP_E2E_API_KEY (an np_test_ key with
// checkout, payments, invoices and reconciliation scopes, sandbox enabled)
// are set. Optional: PAYMENTSNP_E2E_WEBHOOK_SECRET plus
// PAYMENTSNP_E2E_WEBHOOK_CAPTURE (a JSON-lines file of {headers, body}
// deliveries captured from the server) to check real webhook signatures.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { InvalidRequestError, Paymentsnp, PermissionError, toPaisa } from "../dist/esm/index.js";

const baseUrl = process.env.PAYMENTSNP_E2E_BASE_URL;
const apiKey = process.env.PAYMENTSNP_E2E_API_KEY;
const skip = !baseUrl || !apiKey ? "PAYMENTSNP_E2E_BASE_URL / PAYMENTSNP_E2E_API_KEY not set" : false;

test("live API round trip", { skip, timeout: 120_000 }, async (t) => {
  const pnp = new Paymentsnp({ apiKey, baseUrl });
  assert.equal(pnp.environment, "test");
  const order = `SDK-TS-${randomUUID().slice(0, 8)}`;
  let session, paymentId;

  await t.test("checkout create is idempotent", async () => {
    const params = { order_id: order, amount_minor: toPaisa("150.00"), currency: "NPR", description: "SDK e2e", allowed_methods: ["sandbox"], customer: { email: "buyer@example.test", name: "Buyer" } };
    session = await pnp.checkout.sessions.create(params, { idempotencyKey: `sdk-${order}` });
    assert.equal(session.status, "open");
    assert.equal(session.amount_minor, 15000);
    assert.match(session.checkout_url, /\/c\/[A-Za-z0-9_-]{43}$/);
    const replay = await pnp.checkout.sessions.create(params, { idempotencyKey: `sdk-${order}` });
    assert.equal(replay.id, session.id);
    await assert.rejects(
      pnp.checkout.sessions.create({ ...params, amount_minor: 1 }, { idempotencyKey: `sdk-${order}` }),
      (e) => e instanceof InvalidRequestError && e.code === "idempotency_conflict" && e.status === 409,
    );
  });

  await t.test("retrieve", async () => {
    const got = await pnp.checkout.sessions.retrieve(session.id);
    assert.equal(got.id, session.id);
    assert.equal(got.order_id, order);
  });

  await t.test("sandbox payment shows up in payments", async () => {
    // Pay through the public hosted-checkout endpoints, as the browser would.
    const token = session.checkout_url.split("/").pop();
    const post = (path, body) =>
      fetch(`${baseUrl}/checkout/public/${token}/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.ok((await post("attempts", { provider: "sandbox" })).ok);
    const paid = await (await post("simulate", { outcome: "succeeded" })).json();
    assert.equal(paid.status, "succeeded");
    paymentId = paid.payment_id;
    const list = await pnp.payments.list({ limit: 10 });
    assert.equal(list.environment, "test");
    const row = list.data.find((p) => p.id === paymentId);
    assert.ok(row, "payment listed");
    assert.equal(row.order_id, order);
    assert.equal(row.is_simulated, true);
    const one = await pnp.payments.retrieve(paymentId);
    assert.equal(one.amount_minor, 15000);
    const summary = await pnp.payments.summary();
    assert.equal(summary.is_balance, false);
    assert.ok(summary.successful_payment_count >= 1);
    assert.equal((await pnp.checkout.sessions.retrieve(session.id)).status, "paid");
  });

  await t.test("expire another session", async () => {
    const other = await pnp.checkout.sessions.create({ order_id: `${order}-B`, amount_minor: 5000, currency: "NPR" });
    const expired = await pnp.checkout.sessions.expire(other.id);
    assert.equal(expired.status, "expired");
    assert.equal((await pnp.checkout.sessions.expire(other.id)).status, "expired");
  });

  await t.test("environment and not-found errors", async () => {
    await assert.rejects(pnp.payments.list({ environment: "live" }), (e) => e instanceof PermissionError && e.code === "environment_mismatch");
    await assert.rejects(pnp.payments.retrieve(randomUUID()), (e) => e instanceof InvalidRequestError && e.status === 404 && !!e.requestId);
  });

  await t.test("invoices", async () => {
    const draft = await pnp.invoices.create({
      customer: { email: "invoice@example.test", name: "Invoice Buyer" },
      line_items: [{ description: "Consulting", quantity: 2, unit_amount_minor: toPaisa("1,000") }],
      vat_enabled: true,
    });
    assert.equal(draft.status, "draft");
    assert.equal(draft.subtotal_minor, 200000);
    assert.equal(draft.vat_minor, 26000);
    const updated = await pnp.invoices.update(draft.id, {
      customer_id: draft.customer_id,
      line_items: [{ description: "Consulting", quantity: 3, unit_amount_minor: 100000, vat: false }],
      memo: "Thanks",
    });
    assert.equal(updated.total_minor, 300000);
    const open = await pnp.invoices.finalize(draft.id);
    assert.equal(open.status, "open");
    assert.match(open.invoice_number, /^INV-\d{4}-\d{4,}$/);
    assert.ok(open.public_url);
    assert.equal((await pnp.invoices.retrieve(draft.id)).invoice_number, open.invoice_number);
    const pdf = await pnp.invoices.pdf(draft.id);
    assert.equal(new TextDecoder().decode(pdf.slice(0, 5)), "%PDF-");
    const list = await pnp.invoices.list({ status: "open" });
    assert.ok(list.data.some((i) => i.id === draft.id));
    const copy = await pnp.invoices.duplicate(draft.id);
    assert.equal(copy.status, "draft");
    assert.equal((await pnp.invoices.void(copy.id)).status, "void");
    assert.equal((await pnp.invoices.markUncollectible(draft.id)).status, "uncollectible");
    assert.equal((await pnp.invoices.markPaid(draft.id, { note: "Paid in cash" })).status, "paid");
  });

  await t.test("reconciliation", async () => {
    const one = await pnp.reconciliation.list({ limit: 5 });
    assert.equal(one.environment, "test");
    const ref = `SET-${randomUUID().slice(0, 8)}`;
    const row = await pnp.reconciliation.import({ provider: "khalti", settlement_reference: ref, provider_transaction_id: `T-${ref}`, settled_amount_minor: 1000, settled_at: new Date().toISOString() });
    assert.equal(row.status, "unmatched");
    await assert.rejects(
      pnp.reconciliation.import({ provider: "khalti", settlement_reference: ref, provider_transaction_id: `T-${ref}`, settled_amount_minor: 1000, settled_at: new Date().toISOString() }),
      (e) => e.code === "duplicate_settlement",
    );
    const bulk = await pnp.reconciliation.importBulk({ records: [{ provider: "khalti", settlement_reference: ref, provider_transaction_id: "x", settled_amount_minor: 1, settled_at: new Date().toISOString() }, { provider: "nope" }] });
    assert.deepEqual(bulk.results.map((r) => r.status), ["duplicate", "invalid"]);
    const report = await pnp.reconciliation.report({ period: 7 });
    assert.equal(report.period_days, 7);
    assert.ok(report.totals.settled_count >= 1);
  });

  const secret = process.env.PAYMENTSNP_E2E_WEBHOOK_SECRET;
  const capture = process.env.PAYMENTSNP_E2E_WEBHOOK_CAPTURE;
  await t.test("webhook signed by the server verifies", { skip: !secret || !capture ? "no webhook capture configured" : false }, async () => {
    // The outbox delivers within ~15-20s of the payment.
    let delivery;
    for (let i = 0; i < 60 && !delivery; i++) {
      if (existsSync(capture))
        delivery = readFileSync(capture, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
          .find((d) => JSON.parse(d.body).data?.payment_id === paymentId);
      if (!delivery) await new Promise((r) => setTimeout(r, 1000));
    }
    assert.ok(delivery, "payment.succeeded delivery captured");
    const event = await Paymentsnp.webhooks.constructEvent(delivery.body, delivery.headers["Paymentnp-Signature"], secret);
    assert.equal(event.type, "payment.succeeded");
    assert.equal(event.id, delivery.headers["Paymentnp-Event-Id"]);
    assert.equal(event.data.order_id, order);
    assert.equal(event.data.amount_minor, 15000);
    await assert.rejects(Paymentsnp.webhooks.constructEvent(delivery.body + " ", delivery.headers["Paymentnp-Signature"], secret));
  });
});
