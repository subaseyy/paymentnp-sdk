# Paymentsnp SDKs

Official client libraries for the [Paymentsnp](https://paymentnp.com/developers) payment API: one checkout for eSewa, Khalti and Fonepay in Nepal. Money settles directly to your provider accounts; these libraries create checkouts, read verified payments, manage invoices and reconciliation, and verify signed webhooks.

| Package | Folder | Install | Runtime |
| --- | --- | --- | --- |
| `@paymentsnp/sdk` (+ `paymentsnp` CLI) | [`typescript/`](typescript/) | `npm install @paymentsnp/sdk` (**live on npm**) | Node 18+, Bun, Deno, edge |
| `paymentsnp/paymentsnp-php` | [`php/`](php/) | `composer require paymentsnp/paymentsnp-php` (**live on Packagist**, published from [subaseyy/paymentsnp-php](https://github.com/subaseyy/paymentsnp-php)) | PHP 7.4+ (cURL) |
| `paymentsnp` | [`python/`](python/) | `pip install paymentsnp` (**live on PyPI**) | Python 3.9+ (stdlib only) |
| `@paymentsnp/mcp` (0.1.0) | [`mcp/`](mcp/) | `npx -y @paymentsnp/mcp` (**live on npm**) | Node 20+, MCP server for Claude / Cursor |

All packages have **zero runtime dependencies**, share the same resource and method names, keep the API's snake_case field names, and format money as `NPR 1,234.50` from integer paisa.

## Quick example (TypeScript)

```ts
import Paymentsnp from "@paymentsnp/sdk";

const pnp = new Paymentsnp({ apiKey: process.env.PAYMENTSNP_API_KEY! });
const session = await pnp.checkout.sessions.create(
  { order_id: "order-1001", amount_minor: 150000, currency: "NPR",
    success_url: "https://shop.example.com/orders/1001" },
  { idempotencyKey: "order-1001" },
);
// redirect the customer to session.checkout_url

const event = await Paymentsnp.webhooks.constructEvent(
  rawBody, signatureHeader, process.env.PAYMENTSNP_WEBHOOK_SECRET!,
);
```

Each folder's README has the full reference, error classes, retry and idempotency rules, and framework examples.

## Tests

```sh
(cd typescript && npm ci && npm test)
(cd mcp && node --test)
(cd php && php tests/run.php)
(cd python && python3 -m unittest discover -s tests)
```

CI runs all of them on every push. Live end-to-end tests are skipped unless `PAYMENTSNP_E2E_BASE_URL` and `PAYMENTSNP_E2E_API_KEY` point at a test-mode workspace.

## Publishing

`@paymentsnp/sdk` is published on npm, `paymentsnp/paymentsnp-php` on Packagist (copy `php/` changes to `subaseyy/paymentsnp-php` and tag a release there) and `paymentsnp` on PyPI (`python -m build && twine upload dist/*` from `python/` for new versions). `@paymentsnp/mcp` is on npm too, so every package is published; bump the version and re-publish from each folder for new releases.

The source of truth is the Paymentsnp monorepo (`sdks/`); changes there are copied here for release.
