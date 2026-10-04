# Paymentsnp Python SDK

Official Python client for the Paymentsnp API: hosted checkout for eSewa, Khalti and Fonepay, verified payments, invoices, settlement reconciliation and webhook verification.

- Python 3.9 or newer, standard library only, typed (`py.typed`, TypedDicts in `paymentsnp.types`).
- Amounts are NPR in integer **paisa** (`amount_minor`; Rs 1 = 100 paisa).
- Responses are the API's JSON as dicts, with the API's snake_case field names.

## Install

```sh
pip install paymentsnp
```

## Quick start

```python
from paymentsnp import Paymentsnp, to_paisa

client = Paymentsnp(api_key="np_test_...")

session = client.checkout.sessions.create(
    {
        "order_id": "ORD-1001",
        "amount_minor": to_paisa("1,250.00"),  # 125000
        "currency": "NPR",
        "customer": {"email": "buyer@example.com", "name": "Sita Sharma"},
        "success_url": "https://shop.example.com/orders/ORD-1001",
        "cancel_url": "https://shop.example.com/cart",
    },
    idempotency_key="checkout-ORD-1001",
)
print(session["checkout_url"])
```

The key's prefix sets the environment: `np_test_` keys only see test data, `np_live_` keys only live data (`client.environment`). A return to `success_url` is **not** proof of payment. Confirm with the `payment.succeeded` webhook or by retrieving the session.

### Options

```python
Paymentsnp(
    api_key="np_live_...",
    base_url="https://api.paymentnp.com/v1",  # default
    timeout=30,                               # seconds
    max_retries=2,
    transport=None,  # callable(method, url, headers, body, timeout) -> (status, headers, body)
)
```

## Resources

| Method | API | Scope |
| --- | --- | --- |
| `checkout.sessions.create(params, idempotency_key=None)` | `POST /checkout/sessions` | `checkout:create` |
| `checkout.sessions.retrieve(id)` | `GET /checkout/sessions/:id` | `checkout:read` |
| `checkout.sessions.expire(id)` | `POST /checkout/sessions/:id/expire` | `checkout:create` |
| `payments.list(params)` | `GET /payments` (`limit`, `offset`, `provider`, `search`, `from`/`to`) | `payments:read` |
| `payments.retrieve(id)` | `GET /payments/:id` | `payments:read` |
| `payments.summary()` | `GET /payments/summary` (verified totals, never a balance) | `payments:read` |
| `invoices.list(params)` | `GET /invoices` (`status`, `search`, `limit`, `offset`) | `invoices:read` |
| `invoices.retrieve(id)` | `GET /invoices/:id` | `invoices:read` |
| `invoices.pdf(id)` | `GET /invoices/:id/pdf`, returns `bytes` | `invoices:read` |
| `invoices.create(params)` | `POST /invoices` (a draft) | `invoices:write` |
| `invoices.update(id, params)` | `PATCH /invoices/:id` (drafts) | `invoices:write` |
| `invoices.finalize(id)` | `POST /invoices/:id/finalize` | `invoices:write` |
| `invoices.send(id, {"channels": ["email"]})` | `POST /invoices/:id/send` | `invoices:write` |
| `invoices.mark_paid(id, {"note": ...})` | `POST /invoices/:id/mark-paid` | `invoices:write` |
| `invoices.void(id)` | `POST /invoices/:id/void` | `invoices:write` |
| `invoices.mark_uncollectible(id)` | `POST /invoices/:id/uncollectible` | `invoices:write` |
| `invoices.duplicate(id)` | `POST /invoices/:id/duplicate` | `invoices:write` |
| `reconciliation.list(params)` | `GET /reconciliation` | `reconciliation:read` |
| `reconciliation.report({"period": "30"})` | `GET /reconciliation/report` (`7`, `30`, `90`) | `reconciliation:read` |
| `reconciliation.import_settlement(record)` | `POST /reconciliation/import` | `reconciliation:write` |
| `reconciliation.import_bulk({"records": [...]})` | `POST /reconciliation/import/bulk` (up to 500, per-row results) | `reconciliation:write` |

`import` is a Python keyword, so the import methods are `import_settlement` and `import_bulk` (the same names in every Paymentsnp SDK). Refunds and payouts are not part of the API.

## Idempotency and retries

`checkout.sessions.create` always sends an `Idempotency-Key`. If you pass none, the SDK generates one per call and reuses it on that call's retries. Pass your own (for example `checkout-<order id>`) so a retry from a new request or process returns the same session; the same key with a different body raises `InvalidRequestError` (409 `idempotency_conflict`).

The SDK retries connection errors, 429 and 5xx up to `max_retries` times with exponential backoff and jitter, honouring `Retry-After` (capped at 60 seconds). It retries only GET requests and POSTs that carry an idempotency key, so invoice and reconciliation writes are never sent twice.

## Errors

All errors extend `paymentsnp.PaymentsnpError` with `status`, `code` (the API's snake_case code), `message`, `request_id` and `retry_after`.

| Class | When | Typical codes |
| --- | --- | --- |
| `AuthenticationError` | 401 | `unauthorized`, `api_key_expired` |
| `PermissionError` | 403 | `insufficient_scope`, `api_key_ip_denied`, `environment_mismatch` |
| `InvalidRequestError` | 400, 404, 409, 422 | `invalid_request`, `not_found`, `idempotency_conflict`, `duplicate_settlement` |
| `RateLimitError` | 429 | `rate_limited` (see `retry_after`) |
| `ApiError` | 5xx | `internal_error` |
| `ConnectionError` | no response | network, DNS, TLS or timeout |
| `SignatureVerificationError` | webhook check failed | |

`paymentsnp.PermissionError` and `paymentsnp.ConnectionError` are the SDK's own classes (they do not subclass the built-ins of the same name), so import them from `paymentsnp` or catch `PaymentsnpError`.

```python
import paymentsnp

try:
    client.payments.retrieve(payment_id)
except paymentsnp.InvalidRequestError as e:
    print(e.status, e.code, e.request_id)
```

## Webhooks

Paymentsnp signs each delivery with `Paymentnp-Signature: t=<unix>,v1=<hex>` (HMAC-SHA256 of `"<t>.<raw body>"` with your `whsec_` secret) and sends `Paymentnp-Event-Id`. Events: `payment.succeeded`, `payment.failed`, `checkout.expired`, `webhook.test`. The body is `{id, type, api_version, environment, created_at, data}`.

```python
from paymentsnp import Webhook, SignatureVerificationError

event = Webhook.construct_event(
    raw_body,                                 # bytes or str, exactly as received
    request.headers.get("Paymentnp-Signature"),
    os.environ["PAYMENTSNP_WEBHOOK_SECRET"],
    tolerance=300,                            # seconds (default)
)
```

Pass the raw body, not parsed JSON: Flask `request.get_data()`, Django `request.body`, FastAPI `await request.body()`. Signatures are compared in constant time and timestamps older than the tolerance are rejected. Deliveries are retried, so de-duplicate on `event["id"]`; reply 2xx quickly (redirects count as failures). For tests, `Webhook.generate_test_header(body, secret, timestamp=None)` builds a valid header.

## Money helpers

```python
from paymentsnp import to_paisa, format_npr

to_paisa("1,234.50")  # 123450; accepts str, int or Decimal, max 2 decimals; floats raise TypeError
format_npr(123450)    # "NPR 1,234.50"
```

## Examples

- `examples/flask_app.py`: checkout redirect and webhook
- `examples/django_views.py`: checkout view and webhook view
- `examples/fastapi_webhook.py`: webhook with the raw body

## Tests

```sh
python3 -m unittest discover -s tests
```

The unit tests use a stub transport. `tests/test_e2e.py` runs only when `PAYMENTSNP_E2E_BASE_URL` (e.g. `http://localhost:4000/v1`) and `PAYMENTSNP_E2E_API_KEY` (a test key with all scopes, Sandbox gateway enabled, backend started with `ENABLE_SANDBOX_PROVIDER=true`) are set.
