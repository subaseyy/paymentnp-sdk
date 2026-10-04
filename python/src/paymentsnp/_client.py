from __future__ import annotations

import http.client
import json
import random
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any, Callable, Dict, Mapping, Optional, Tuple, cast

from ._errors import ApiError, ConnectionError, PaymentsnpError, RateLimitError, error_from_response
from .types import CheckoutSession, CheckoutSessionCreateParams, Payment, PaymentList

VERSION = "1.0.0"
DEFAULT_BASE_URL = "https://api.paymentnp.com/v1"

Params = Mapping[str, Any]
# (method, url, headers, body, timeout) -> (status, lower-cased headers, body)
Transport = Callable[[str, str, Dict[str, str], Optional[bytes], float], Tuple[int, Dict[str, str], bytes]]


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        return None


_opener = urllib.request.build_opener(_NoRedirect)


def urllib_transport(
    method: str, url: str, headers: Dict[str, str], body: Optional[bytes], timeout: float
) -> Tuple[int, Dict[str, str], bytes]:
    """Default transport: urllib, TLS verified by the default context, no redirects."""
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with _opener.open(request, timeout=timeout) as response:
            return response.status, {k.lower(): v for k, v in response.headers.items()}, response.read()
    except urllib.error.HTTPError as error:
        with error:
            return error.code, {k.lower(): v for k, v in error.headers.items()}, error.read()
    except (OSError, http.client.HTTPException) as error:
        host = urllib.parse.urlsplit(url).hostname
        raise ConnectionError(f"Could not reach the Paymentsnp API at {host}: {error}") from error


def _backoff(attempt: int, retry_after: Optional[int]) -> float:
    """Retry-After (capped at 60s) or exponential backoff with jitter."""
    if retry_after is not None:
        return float(min(60, max(0, retry_after)))
    base: float = min(8.0, 0.5 * 2.0**attempt)
    return base / 2 + random.uniform(0, base / 2)


def _id(value: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError("An id is required.")
    return urllib.parse.quote(value, safe="")


class Paymentsnp:
    """Paymentsnp API client.

    >>> client = Paymentsnp(api_key="np_test_...")
    >>> session = client.checkout.sessions.create({...})
    """

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = 30,
        max_retries: int = 2,
        transport: Optional[Transport] = None,
    ) -> None:
        match = re.match(r"^np_(test|live)_", api_key) if isinstance(api_key, str) else None
        if not match:
            raise ValueError("api_key must be a Paymentsnp API key starting with np_test_ or np_live_.")
        self._api_key = api_key
        self.environment: str = match.group(1)
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.max_retries = max(0, int(max_retries))
        self._transport: Transport = transport or urllib_transport
        self.checkout = _Checkout(self)
        self.payments = Payments(self)
        self.invoices = Invoices(self)
        self.reconciliation = Reconciliation(self)

    def __repr__(self) -> str:
        return f"Paymentsnp(environment={self.environment!r}, base_url={self.base_url!r})"

    def request(
        self,
        method: str,
        path: str,
        params: Optional[Params] = None,
        *,
        idempotency_key: Optional[str] = None,
        raw: bool = False,
    ) -> Any:
        """Send one request. GET params go in the query string, others in the JSON body.

        Retries connection errors, 429 and 5xx, but only GETs and POSTs that
        carry an Idempotency-Key.
        """
        method = method.upper()
        url = self.base_url + path
        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Accept": "application/pdf" if raw else "application/json",
            "User-Agent": f"paymentsnp-python/{VERSION}",
        }
        body: Optional[bytes] = None
        if method == "GET":
            if params:
                url += "?" + urllib.parse.urlencode(params, quote_via=urllib.parse.quote)
        else:
            body = json.dumps(dict(params or {}), separators=(",", ":"), ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        if idempotency_key is not None:
            headers["Idempotency-Key"] = idempotency_key
        retryable = method == "GET" or (method == "POST" and idempotency_key is not None)

        attempt = 0
        while True:
            try:
                status, response_headers, content = self._transport(method, url, headers, body, self.timeout)
                if 200 <= status < 300:
                    if raw:
                        return content
                    return json.loads(content.decode("utf-8")) if content else None
                error: PaymentsnpError = error_from_response(status, content, response_headers)
            except ConnectionError as exc:
                error = exc
            transient = isinstance(error, (ConnectionError, RateLimitError, ApiError))
            if not retryable or not transient or attempt >= self.max_retries:
                raise error
            time.sleep(_backoff(attempt, error.retry_after))
            attempt += 1


class _Resource:
    def __init__(self, client: Paymentsnp) -> None:
        self._client = client


class CheckoutSessions(_Resource):
    """Scopes: checkout:create (create, expire), checkout:read (retrieve)."""

    def create(self, params: CheckoutSessionCreateParams, idempotency_key: Optional[str] = None) -> CheckoutSession:
        """POST /checkout/sessions. ``amount_minor`` is integer paisa.

        Without ``idempotency_key`` one is generated and reused on this call's
        retries. Pass your own (e.g. from your order id) to make retries across
        requests or processes safe.
        """
        key = idempotency_key or str(uuid.uuid4())
        return cast(CheckoutSession, self._client.request("POST", "/checkout/sessions", params, idempotency_key=key))

    def retrieve(self, id: str) -> CheckoutSession:
        return cast(CheckoutSession, self._client.request("GET", f"/checkout/sessions/{_id(id)}"))

    def expire(self, id: str) -> CheckoutSession:
        return cast(CheckoutSession, self._client.request("POST", f"/checkout/sessions/{_id(id)}/expire"))


class _Checkout:
    def __init__(self, client: Paymentsnp) -> None:
        self.sessions = CheckoutSessions(client)


class Payments(_Resource):
    """Verified payments. Scope: payments:read."""

    def list(self, params: Optional[Params] = None) -> PaymentList:
        """Params: limit, offset, provider, search, from, to (Nepal dates, both or neither)."""
        return cast(PaymentList, self._client.request("GET", "/payments", params))

    def retrieve(self, id: str) -> Payment:
        return cast(Payment, self._client.request("GET", f"/payments/{_id(id)}"))

    def summary(self, params: Optional[Params] = None) -> Dict[str, Any]:
        """Verified totals for the key's environment; never a balance."""
        return cast(Dict[str, Any], self._client.request("GET", "/payments/summary", params))


class Invoices(_Resource):
    """Scopes: invoices:read (list, retrieve, pdf), invoices:write (the rest)."""

    def list(self, params: Optional[Params] = None) -> Dict[str, Any]:
        """Params: status, search, limit, offset."""
        return cast(Dict[str, Any], self._client.request("GET", "/invoices", params))

    def retrieve(self, id: str) -> Dict[str, Any]:
        return cast(Dict[str, Any], self._client.request("GET", f"/invoices/{_id(id)}"))

    def create(self, params: Params) -> Dict[str, Any]:
        """Create a draft. Params: customer_id or customer, line_items, vat_enabled,
        discount, days_until_due, due_date, memo, footer."""
        return cast(Dict[str, Any], self._client.request("POST", "/invoices", params))

    def update(self, id: str, params: Params) -> Dict[str, Any]:
        """Update a draft (same params as create)."""
        return cast(Dict[str, Any], self._client.request("PATCH", f"/invoices/{_id(id)}", params))

    def finalize(self, id: str) -> Dict[str, Any]:
        return cast(Dict[str, Any], self._client.request("POST", f"/invoices/{_id(id)}/finalize"))

    def send(self, id: str, params: Optional[Params] = None) -> Dict[str, Any]:
        """Params: channels (["email"], ["sms"] or both; default email)."""
        return cast(Dict[str, Any], self._client.request("POST", f"/invoices/{_id(id)}/send", params))

    def mark_paid(self, id: str, params: Params) -> Dict[str, Any]:
        """Params: note (3-500 characters)."""
        return cast(Dict[str, Any], self._client.request("POST", f"/invoices/{_id(id)}/mark-paid", params))

    def void(self, id: str) -> Dict[str, Any]:
        return cast(Dict[str, Any], self._client.request("POST", f"/invoices/{_id(id)}/void"))

    def mark_uncollectible(self, id: str) -> Dict[str, Any]:
        return cast(Dict[str, Any], self._client.request("POST", f"/invoices/{_id(id)}/uncollectible"))

    def duplicate(self, id: str) -> Dict[str, Any]:
        """A new draft copy."""
        return cast(Dict[str, Any], self._client.request("POST", f"/invoices/{_id(id)}/duplicate"))

    def pdf(self, id: str) -> bytes:
        """The invoice PDF as bytes."""
        return cast(bytes, self._client.request("GET", f"/invoices/{_id(id)}/pdf", raw=True))


class Reconciliation(_Resource):
    """Settlement records. Scopes: reconciliation:read, reconciliation:write."""

    def list(self, params: Optional[Params] = None) -> Dict[str, Any]:
        """Params: limit, offset."""
        return cast(Dict[str, Any], self._client.request("GET", "/reconciliation", params))

    def report(self, params: Optional[Params] = None) -> Dict[str, Any]:
        """Params: period "7", "30" or "90"."""
        return cast(Dict[str, Any], self._client.request("GET", "/reconciliation/report", params))

    def import_settlement(self, params: Params) -> Dict[str, Any]:
        """POST /reconciliation/import. Params: provider, settlement_reference,
        provider_transaction_id, settled_amount_minor, settled_at.
        A repeated settlement_reference raises InvalidRequestError (409 duplicate_settlement)."""
        return cast(Dict[str, Any], self._client.request("POST", "/reconciliation/import", params))

    def import_bulk(self, params: Params) -> Dict[str, Any]:
        """POST /reconciliation/import/bulk. Params: records (1-500 rows); per-row results."""
        return cast(Dict[str, Any], self._client.request("POST", "/reconciliation/import/bulk", params))
