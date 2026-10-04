# Paymentsnp PHP SDK

Official PHP client for the Paymentsnp API: hosted checkout for eSewa, Khalti and Fonepay, verified payments, invoices, settlement reconciliation and webhook verification.

- PHP 7.4 or newer, `ext-curl` and `ext-json`. No other dependencies.
- Amounts are NPR in integer **paisa** (`amount_minor`; Rs 1 = 100 paisa).
- Responses are the API's JSON decoded to arrays, with the API's snake_case field names.

## Install

```sh
composer require paymentsnp/paymentsnp-php
```

Without Composer (WHMCS modules and similar), copy this folder and:

```php
require_once '/path/to/paymentsnp-php/init.php';
```

## Quick start

```php
$paymentsnp = new \Paymentsnp\PaymentsnpClient('np_test_...');

$session = $paymentsnp->checkout->sessions->create([
    'order_id' => 'ORD-1001',
    'amount_minor' => \Paymentsnp\Money::toPaisa('1,250.00'), // 125000
    'currency' => 'NPR',
    'customer' => ['email' => 'buyer@example.com', 'name' => 'Sita Sharma'],
    'success_url' => 'https://shop.example.com/orders/ORD-1001',
    'cancel_url' => 'https://shop.example.com/cart',
], ['idempotency_key' => 'checkout-ORD-1001']);

header('Location: ' . $session['checkout_url']);
```

The key's prefix sets the environment: `np_test_` keys only see test data, `np_live_` keys only live data (`$paymentsnp->environment`). A return to `success_url` is **not** proof of payment. Confirm with the `payment.succeeded` webhook or by retrieving the session.

### Options

```php
new PaymentsnpClient('np_live_...', [
    'base_url' => 'https://api.paymentnp.com/v1', // default
    'timeout' => 30,                                // seconds
    'max_retries' => 2,
    'http_client' => $myClient,                     // implements Paymentsnp\HttpClient
]);
// or new PaymentsnpClient(['api_key' => 'np_live_...', ...])
```

## Resources

Each method names the API key scope it needs.

| Method | API | Scope |
| --- | --- | --- |
| `checkout->sessions->create($params, ['idempotency_key' => ...])` | `POST /checkout/sessions` | `checkout:create` |
| `checkout->sessions->retrieve($id)` | `GET /checkout/sessions/:id` | `checkout:read` |
| `checkout->sessions->expire($id)` | `POST /checkout/sessions/:id/expire` | `checkout:create` |
| `payments->list($params)` | `GET /payments` (`limit`, `offset`, `provider`, `search`, `from`/`to`) | `payments:read` |
| `payments->retrieve($id)` | `GET /payments/:id` | `payments:read` |
| `payments->summary()` | `GET /payments/summary` (verified totals, never a balance) | `payments:read` |
| `invoices->list($params)` | `GET /invoices` (`status`, `search`, `limit`, `offset`) | `invoices:read` |
| `invoices->retrieve($id)` | `GET /invoices/:id` | `invoices:read` |
| `invoices->pdf($id)` | `GET /invoices/:id/pdf`, returns the PDF bytes | `invoices:read` |
| `invoices->create($params)` | `POST /invoices` (a draft) | `invoices:write` |
| `invoices->update($id, $params)` | `PATCH /invoices/:id` (drafts) | `invoices:write` |
| `invoices->finalize($id)` | `POST /invoices/:id/finalize` | `invoices:write` |
| `invoices->send($id, ['channels' => ['email']])` | `POST /invoices/:id/send` | `invoices:write` |
| `invoices->markPaid($id, ['note' => ...])` | `POST /invoices/:id/mark-paid` | `invoices:write` |
| `invoices->void($id)` | `POST /invoices/:id/void` | `invoices:write` |
| `invoices->markUncollectible($id)` | `POST /invoices/:id/uncollectible` | `invoices:write` |
| `invoices->duplicate($id)` | `POST /invoices/:id/duplicate` | `invoices:write` |
| `reconciliation->list($params)` | `GET /reconciliation` | `reconciliation:read` |
| `reconciliation->report(['period' => '30'])` | `GET /reconciliation/report` (`7`, `30`, `90`) | `reconciliation:read` |
| `reconciliation->importSettlement($record)` | `POST /reconciliation/import` | `reconciliation:write` |
| `reconciliation->importBulk(['records' => [...]])` | `POST /reconciliation/import/bulk` (up to 500, per-row results) | `reconciliation:write` |

Refunds and payouts are not part of the API.

## Idempotency and retries

`checkout->sessions->create` always sends an `Idempotency-Key`. If you pass none, the SDK generates one per call and reuses it on that call's retries. Pass your own (for example `checkout-<order id>`) so a retry from a new request or process returns the same session; the same key with a different body raises `InvalidRequestError` (409 `idempotency_conflict`).

The SDK retries connection errors, 429 and 5xx up to `max_retries` times with exponential backoff and jitter, honouring `Retry-After` (capped at 60 seconds). It retries only GET requests and POSTs that carry an idempotency key, so invoice and reconciliation writes are never sent twice.

## Errors

All errors extend `Paymentsnp\PaymentsnpError` with `getStatus()`, `getErrorCode()` (the API's snake_case code), `getMessage()`, `getRequestId()` and `getRetryAfter()`.

| Class | When | Typical codes |
| --- | --- | --- |
| `AuthenticationError` | 401 | `unauthorized`, `api_key_expired` |
| `PermissionError` | 403 | `insufficient_scope`, `api_key_ip_denied`, `environment_mismatch` |
| `InvalidRequestError` | 400, 404, 409, 422 | `invalid_request`, `not_found`, `idempotency_conflict`, `duplicate_settlement` |
| `RateLimitError` | 429 | `rate_limited` (see `getRetryAfter()`) |
| `ApiError` | 5xx | `internal_error` |
| `ConnectionError` | no response | network, DNS, TLS or timeout |
| `SignatureVerificationError` | webhook check failed | |

```php
try {
    $paymentsnp->payments->retrieve($id);
} catch (\Paymentsnp\InvalidRequestError $e) {
    error_log($e->getErrorCode() . ' ' . $e->getRequestId());
}
```

## Webhooks

Paymentsnp signs each delivery with `Paymentnp-Signature: t=<unix>,v1=<hex>` (HMAC-SHA256 of `"<t>.<raw body>"` with your `whsec_` secret) and sends `Paymentnp-Event-Id`. Events: `payment.succeeded`, `payment.failed`, `checkout.expired`, `webhook.test`. The body is `{id, type, api_version, environment, created_at, data}`.

```php
$event = \Paymentsnp\Webhook::constructEvent(
    file_get_contents('php://input'),            // raw body
    $_SERVER['HTTP_PAYMENTNP_SIGNATURE'] ?? '',
    getenv('PAYMENTSNP_WEBHOOK_SECRET'),
    300                                           // tolerance in seconds (default)
);
```

It compares signatures in constant time, rejects timestamps older than the tolerance and throws `SignatureVerificationError`. Deliveries are retried, so de-duplicate on the event id. Reply 2xx quickly; redirects count as failures. For tests, `Webhook::generateTestHeader($body, $secret, $timestamp = null)` builds a valid header.

## Money helpers

```php
\Paymentsnp\Money::toPaisa('1,234.50'); // 123450 (string math; floats are rejected)
\Paymentsnp\Money::formatNpr(123450);   // "NPR 1,234.50"
```

## Examples

- `examples/create-checkout.php`: plain PHP checkout redirect
- `examples/webhook.php`: plain PHP webhook endpoint
- `examples/laravel-routes.php`: Laravel checkout route and webhook route

## Tests

```sh
php tests/run.php
# against PHP 7.4 and 8.3:
docker run --rm -v "$PWD":/app -w /app php:7.4-cli php tests/run.php
docker run --rm -v "$PWD":/app -w /app php:8.3-cli php tests/run.php
```

The unit tests use a stub `HttpClient`. The live tests in `tests/e2e.php` run only when `PAYMENTSNP_E2E_BASE_URL` (e.g. `http://localhost:4000/v1`) and `PAYMENTSNP_E2E_API_KEY` (a test key with all scopes, Sandbox gateway enabled, backend started with `ENABLE_SANDBOX_PROVIDER=true`) are set.
