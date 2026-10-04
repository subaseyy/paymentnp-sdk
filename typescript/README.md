# Paymentsnp TypeScript / JavaScript SDK

Official server-side SDK and CLI for the [Paymentsnp](https://paymentnp.com) API:
one checkout in front of eSewa, Khalti and Fonepay. Payments settle straight to your
own provider accounts. Paymentsnp creates checkouts, verifies payments and sends
signed webhooks.

- Zero runtime dependencies. Uses the global `fetch` and Web Crypto, so it runs on Node 18+, Bun, Deno and edge runtimes (Vercel Edge, Cloudflare Workers).
- ESM and CommonJS builds with bundled TypeScript types.
- Automatic retries with backoff, idempotent checkout creation, typed errors.
- Webhook verification that works on Web Crypto (`await constructEvent(...)`).
- A small `paymentsnp` CLI.

> **Server-side only.** Your `np_test_…` / `np_live_…` key is a secret. Never ship it to a browser or mobile app.

## Install

```sh
npm install @paymentsnp/sdk
# pnpm add @paymentsnp/sdk · yarn add @paymentsnp/sdk · bun add @paymentsnp/sdk
```

## Quickstart

```ts
import { Paymentsnp, toPaisa } from "@paymentsnp/sdk";

const pnp = new Paymentsnp({ apiKey: process.env.PAYMENTSNP_API_KEY! });

const session = await pnp.checkout.sessions.create({
  order_id: "ORD-1001",
  amount_minor: toPaisa("1,500.00"), // 150000 paisa
  currency: "NPR",
  success_url: "https://shop.example.com/thanks",
  cancel_url: "https://shop.example.com/cart",
});
// Redirect the customer to session.checkout_url, then wait for the
// payment.succeeded webhook (or poll checkout.sessions.retrieve).
```

CommonJS: `const { Paymentsnp } = require("@paymentsnp/sdk");`

The return URL is **never** proof of payment. Treat an order as paid only after a verified
`payment.succeeded` webhook or after reading the session/payment through the API.

## Conventions

- **Field names are the API's own snake_case names**, in both params and responses (`order_id`, `amount_minor`, `checkout_url`). The SDK does not rename anything, so the [API reference](https://api.paymentnp.com/docs) applies as-is.
- **Amounts are integer paisa** (NPR × 100) in every `*_minor` field. Use `toPaisa()` and `formatNpr()` instead of float maths.
- **Environment comes from the key.** `np_test_…` keys see only test data and `np_live_…` keys only live data (`pnp.environment` is `"test"` or `"live"`). Passing the other `environment` returns 403 `environment_mismatch`.
- Each method needs the scope shown below. Choose the key's scopes under Dashboard → API keys.

## Client options

```ts
new Paymentsnp({
  apiKey: "np_test_…",                       // required; must start with np_test_ or np_live_
  baseUrl: "https://api.paymentnp.com/v1",   // default
  timeoutMs: 30000,                          // per attempt
  maxRetries: 2,
  fetch: customFetch,                        // optional
});
```

The constructor throws if the key has the wrong prefix. The key is kept in a private field, so it never shows up when the client is logged or serialised.

## API reference

| Method | HTTP | Scope |
| --- | --- | --- |
| `checkout.sessions.create(params, { idempotencyKey? })` | `POST /v1/checkout/sessions` | `checkout:create` |
| `checkout.sessions.retrieve(id)` | `GET /v1/checkout/sessions/:id` | `checkout:read` |
| `checkout.sessions.expire(id)` | `POST /v1/checkout/sessions/:id/expire` | `checkout:create` |
| `payments.list(params?)` | `GET /v1/payments` | `payments:read` |
| `payments.retrieve(id)` | `GET /v1/payments/:id` | `payments:read` |
| `payments.summary()` | `GET /v1/payments/summary` | `payments:read` |
| `invoices.list(params?)` | `GET /v1/invoices` | `invoices:read` |
| `invoices.retrieve(id)` | `GET /v1/invoices/:id` | `invoices:read` |
| `invoices.pdf(id)` → `Uint8Array` | `GET /v1/invoices/:id/pdf` | `invoices:read` |
| `invoices.create(params)` | `POST /v1/invoices` | `invoices:write` |
| `invoices.update(id, params)` | `PATCH /v1/invoices/:id` | `invoices:write` |
| `invoices.finalize(id)` | `POST /v1/invoices/:id/finalize` | `invoices:write` |
| `invoices.send(id, { channels? })` | `POST /v1/invoices/:id/send` | `invoices:write` |
| `invoices.markPaid(id, { note })` | `POST /v1/invoices/:id/mark-paid` | `invoices:write` |
| `invoices.void(id)` | `POST /v1/invoices/:id/void` | `invoices:write` |
| `invoices.markUncollectible(id)` | `POST /v1/invoices/:id/uncollectible` | `invoices:write` |
| `invoices.duplicate(id)` | `POST /v1/invoices/:id/duplicate` | `invoices:write` |
| `reconciliation.list(params?)` | `GET /v1/reconciliation` | `reconciliation:read` |
| `reconciliation.report({ period? })` | `GET /v1/reconciliation/report` | `reconciliation:read` |
| `reconciliation.import(record)` | `POST /v1/reconciliation/import` | `reconciliation:write` |
| `reconciliation.importBulk({ records })` | `POST /v1/reconciliation/import/bulk` | `reconciliation:write` |

Dashboard-only routes (CSV exports, invoice receipt resend, reconciliation review, webhooks, keys) are not available to API keys and are not in the SDK. Refunds and payouts do not exist: Paymentsnp never holds funds.

### Checkout sessions

```ts
const session = await pnp.checkout.sessions.create(
  {
    order_id: "ORD-1001",          // your reference; amount/currency/customer are fixed per order
    amount_minor: 150000,
    currency: "NPR",
    description: "2 x T-shirt",
    customer: { email: "buyer@example.com", name: "Sita", phone: "98XXXXXXXX" },
    allowed_methods: ["esewa", "khalti"],
    success_url: "https://shop.example.com/thanks",   // origin must be in your Return origins
    cancel_url: "https://shop.example.com/cart",
    metadata: { cart_id: "c_123" },
  },
  { idempotencyKey: "checkout-ORD-1001" },
);
session.checkout_url;   // https://paymentnp.com/c/<token> (or your verified custom domain)
session.status;         // "open"

const current = await pnp.checkout.sessions.retrieve(session.id);
// current.status: "open" | "processing" | "paid" | "expired" | "cancelled"

await pnp.checkout.sessions.expire(session.id); // stop a session from being paid; safe to repeat
```

Sessions expire after 1 hour.

### Payments

Only verified payments are listed. Pending attempts are not payments.

```ts
const page = await pnp.payments.list({ limit: 25, offset: 0, provider: "esewa", search: "ORD-1001", from: "2026-10-01", to: "2026-10-04" });
page.data[0].provider_transaction_id;
page.has_more;

const payment = await pnp.payments.retrieve(page.data[0].id);
const summary = await pnp.payments.summary();
// { gross_payments_received_minor, successful_payment_count, pending_attempt_count, is_balance: false, ... }
```

`from`/`to` are Nepal calendar days (inclusive) and must be sent together.

### Invoices

```ts
const draft = await pnp.invoices.create({
  customer: { email: "buyer@example.com", name: "Sita" }, // or customer_id
  line_items: [{ description: "Consulting", quantity: 2, unit_amount_minor: 100000 }],
  vat_enabled: true,                 // 13% VAT on lines with vat !== false
  discount: { type: "percent", percent: 10 },
  days_until_due: 15,                // or due_date: "2026-10-31"
  memo: "Thank you!",
});
await pnp.invoices.update(draft.id, { customer_id: draft.customer_id!, line_items: [/* full list */] }); // replaces the draft
const open = await pnp.invoices.finalize(draft.id);      // numbered INV-2026-0001, public_url set
await pnp.invoices.send(open.id, { channels: ["email", "sms"] });
const pdf = await pnp.invoices.pdf(open.id);              // Uint8Array
await pnp.invoices.markPaid(open.id, { note: "Paid in cash at the counter" });
await pnp.invoices.void(otherId);
await pnp.invoices.markUncollectible(otherId);
const copy = await pnp.invoices.duplicate(open.id);       // new draft
const list = await pnp.invoices.list({ status: "overdue", limit: 50 });
```

Writing a PDF to disk in Node: `await fs.promises.writeFile("invoice.pdf", pdf)`.

### Reconciliation

```ts
const record = await pnp.reconciliation.import({
  provider: "khalti",
  settlement_reference: "KH-SET-2026-10-04-01",
  provider_transaction_id: "abc123",
  settled_amount_minor: 150000,
  settled_at: "2026-10-04T10:00:00+05:45",
}); // record.status: "matched" | "unmatched" | "mismatch"

const bulk = await pnp.reconciliation.importBulk({ records: [/* up to 500 */] });
bulk.results; // per row: matched / unmatched / mismatch / duplicate / invalid

await pnp.reconciliation.list({ limit: 50 });
await pnp.reconciliation.report({ period: 30 }); // 7, 30 or 90 days
```

## Errors

Every API error has the body `{ "error": { "code", "message", "request_id" } }` and is thrown as a subclass of `PaymentsnpError` with `status`, `code`, `message`, `requestId` and, on 429, `retryAfter` (seconds).

| Class | When | Typical `code` |
| --- | --- | --- |
| `AuthenticationError` | 401 | `unauthorized`, `api_key_expired` |
| `PermissionError` | 403 | `insufficient_scope`, `api_key_ip_denied`, `environment_mismatch` |
| `InvalidRequestError` | 400, 404, 409, 422 | `invalid_request`, `not_found`, `idempotency_conflict`, `invoice_not_draft` |
| `RateLimitError` | 429 | `rate_limited` |
| `ApiError` | 5xx | `internal_error` |
| `ConnectionError` | network failure or timeout (`status` 0) | `connection_error`, `timeout` |
| `SignatureVerificationError` | webhook verification | `signature_mismatch`, `timestamp_out_of_tolerance`, … |

```ts
import { PermissionError, RateLimitError } from "@paymentsnp/sdk";
try {
  await pnp.payments.list();
} catch (error) {
  if (error instanceof PermissionError && error.code === "insufficient_scope") { /* add payments:read */ }
  else if (error instanceof RateLimitError) console.log(`retry in ${error.retryAfter}s`);
  else throw error;
}
```

Include `error.requestId` when you contact support.

## Retries

The SDK retries up to `maxRetries` times (default 2), using exponential backoff with jitter (0.5 s, 1 s, … capped at 8 s). On a 429 it waits for `Retry-After`, capped at 60 s.

| Request | Retried on |
| --- | --- |
| `GET` requests, `checkout.sessions.create`, `checkout.sessions.expire` | network errors, timeouts, 429, 5xx |
| Other `POST`/`PATCH` (invoices, reconciliation imports) **with** `{ idempotencyKey }` | network errors before a response only (not timeouts, not 429/5xx) |
| Other `POST`/`PATCH` **without** `idempotencyKey` | never |

Retrying is safe for checkout creation because each call carries an `Idempotency-Key`. For the other write endpoints the API does **not** deduplicate requests. An `idempotencyKey` there only lets you opt into retrying failures where the request never reached the server; it is sent as a header but the server ignores it. 4xx errors are never retried.

## Idempotency

`checkout.sessions.create` always sends an `Idempotency-Key` header, which the API requires. If you don't pass one, the SDK generates a random UUID once per call and reuses it for that call's retries. Pass your own key (for example `checkout-${orderId}`) to make repeated calls, such as double clicks or job retries, return the same session:

- Same key + same body → the original response, replayed.
- Same key + different body → 409 `idempotency_conflict` (`InvalidRequestError`).

Keys may use `A–Z a–z 0–9 . _ : -` and be up to 120 characters long.

## Webhooks

Paymentsnp POSTs JSON events to your HTTPS endpoint (configure it in Dashboard → Webhooks; the `whsec_…` secret is shown once):

```
Paymentnp-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
Paymentnp-Event-Id: <event id>
```

(The header names keep the technical `Paymentnp` prefix.)

```ts
import { Paymentsnp } from "@paymentsnp/sdk";

const event = await Paymentsnp.webhooks.constructEvent(
  rawBody,                                    // string or Uint8Array: the exact bytes received
  request.headers.get("paymentnp-signature"),
  process.env.PAYMENTSNP_WEBHOOK_SECRET!,
  { toleranceSeconds: 300 },                  // default
);
switch (event.type) {
  case "payment.succeeded": event.data.order_id; event.data.amount_minor; break;
  case "payment.failed":    event.data.attempt_id; event.data.reason; break;
  case "checkout.expired":  event.data.checkout_session_id; break;
  case "webhook.test":      break;
}
```

- `constructEvent` is **async** because it uses Web Crypto. It verifies the signature with a constant-time comparison, accepts any of several `v1=` values, rejects timestamps more than `toleranceSeconds` from now, and then parses the JSON.
- Verify the **raw** body. Use `await request.text()` (Fetch API / Next.js), `express.raw({ type: "application/json" })` (Express) or `req.rawBody`. Re-serialising parsed JSON breaks the signature.
- Deliveries are retried (up to 8 attempts), so dedupe on `event.id`. Respond with any 2xx status; redirects count as failures.
- Event envelope: `{ id, type, api_version: "v1", environment, created_at, data }`. `payment.succeeded` data includes `payment_id`, `checkout_session_id`, `order_id`, `provider`, `provider_transaction_id`, `amount_minor`, `currency`, `is_simulated` and `overpaid` (true when an already-paid order receives a second payment).

Also exported: `webhooks.verifySignature(rawBody, header, secret, options)` (resolves `true` or throws) and `webhooks.generateTestHeader(body, secret, timestamp?)`, which builds a valid header for your own tests:

```ts
const header = await Paymentsnp.webhooks.generateTestHeader(JSON.stringify(fakeEvent), "whsec_test");
await fetch("http://localhost:3000/api/webhooks/paymentsnp", { method: "POST", headers: { "Paymentnp-Signature": header }, body: JSON.stringify(fakeEvent) });
```

## Money helpers

```ts
toPaisa("1,234.50");   // 123450
toPaisa("12,34,567");  // 123456700 (lakh commas allowed)
toPaisa(15);           // 1500
toPaisa("1.234");      // throws RangeError (more than 2 decimals)
toPaisa("-5");         // throws RangeError
formatNpr(123450);     // "NPR 1,234.50"
formatNpr(12345678901) // "NPR 123,456,789.01"
```

`toPaisa` uses string and BigInt maths only, never floats.

## CLI

Installing the package adds a `paymentsnp` command (`npx paymentsnp …`). The API key is read from `PAYMENTSNP_API_KEY`. `--api-key` still works but prints a warning, because a key passed as an argument ends up in your shell history.

```sh
export PAYMENTSNP_API_KEY=np_test_...
paymentsnp checkout create --amount 1500.00 --order ORD-1 --success-url https://shop.example.com/thanks --cancel-url https://shop.example.com/cart
paymentsnp checkout get <session_id>
paymentsnp checkout expire <session_id>
paymentsnp payments list --limit 10
paymentsnp payments get <payment_id>
paymentsnp invoices list --status open

# Local webhook testing (secret from --secret or PAYMENTSNP_WEBHOOK_SECRET)
paymentsnp webhooks sign --secret whsec_... --file body.json            # prints t=...,v1=...
paymentsnp webhooks verify --secret whsec_... --header 't=...,v1=...' --file body.json
```

- `--json` prints the raw API response; without it you get a table, with amounts shown as `NPR …`.
- `--base-url` or `PAYMENTSNP_BASE_URL` points the CLI at another API host.
- `checkout create` also takes `--description`, `--email`, `--phone` and `--idempotency-key`. `--amount` is in rupees.
- `webhooks verify` checks only the signature, not its age, so you can verify captured bodies later.
- Exit codes: `0` success, `1` API or verification error, `2` usage error.

## Examples

- [`examples/nextjs/app/api/checkout/route.ts`](examples/nextjs/app/api/checkout/route.ts): create a checkout from an App Router route.
- [`examples/nextjs/app/api/webhooks/paymentsnp/route.ts`](examples/nextjs/app/api/webhooks/paymentsnp/route.ts): webhook handler that reads the raw body.
- [`examples/express.mjs`](examples/express.mjs): checkout redirect plus a webhook handler using `express.raw`.
- [`examples/node-script.mjs`](examples/node-script.mjs): a plain Node script.

## Development

```sh
npm --prefix sdks/typescript install
npm --prefix sdks/typescript run build   # dist/esm + dist/cjs with .d.ts (tsc only)
npm --prefix sdks/typescript test        # build + unit tests (node:test)
```

`test/e2e.test.mjs` runs against a live API when `PAYMENTSNP_E2E_BASE_URL` and `PAYMENTSNP_E2E_API_KEY` are set; otherwise it is skipped. It needs an `np_test_` key with all checkout, payments, invoices and reconciliation scopes, and Sandbox enabled. Set `PAYMENTSNP_E2E_WEBHOOK_SECRET` and `PAYMENTSNP_E2E_WEBHOOK_CAPTURE` (a JSON-lines file of captured `{headers, body}` deliveries) to also verify real server signatures.

## License

MIT
