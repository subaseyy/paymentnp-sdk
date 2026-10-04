from __future__ import annotations

import json
from typing import Any, Mapping, Optional


class PaymentsnpError(Exception):
    """Base class for every SDK error.

    API errors carry the response's ``{"error": {"code", "message", "request_id"}}``.
    """

    def __init__(
        self,
        message: str,
        status: Optional[int] = None,
        code: Optional[str] = None,
        request_id: Optional[str] = None,
        retry_after: Optional[int] = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.status = status
        self.code = code
        self.request_id = request_id
        self.retry_after = retry_after

    def __repr__(self) -> str:
        return f"{type(self).__name__}(status={self.status!r}, code={self.code!r}, message={self.message!r}, request_id={self.request_id!r})"


class AuthenticationError(PaymentsnpError):
    """401: unauthorized or api_key_expired."""


class PermissionError(PaymentsnpError):  # noqa: A001 - mirrors the other SDKs
    """403: insufficient_scope, api_key_ip_denied, environment_mismatch, ..."""


class InvalidRequestError(PaymentsnpError):
    """400/404/409/422: invalid_request, not_found, idempotency_conflict, ..."""


class RateLimitError(PaymentsnpError):
    """429: rate_limited; ``retry_after`` holds the Retry-After seconds."""


class ApiError(PaymentsnpError):
    """5xx from the API."""


class ConnectionError(PaymentsnpError):  # noqa: A001 - mirrors the other SDKs
    """No HTTP response: DNS, TLS, timeout or connection failure."""


class SignatureVerificationError(PaymentsnpError):
    """A webhook signature, timestamp or body failed verification."""


def error_from_response(status: int, body: bytes, headers: Mapping[str, str]) -> PaymentsnpError:
    try:
        parsed: Any = json.loads(body.decode("utf-8"))
    except ValueError:
        parsed = None
    error = parsed.get("error") if isinstance(parsed, dict) else None
    error = error if isinstance(error, dict) else {}
    retry = headers.get("retry-after")
    cls: "type[PaymentsnpError]" = PaymentsnpError
    if status == 401:
        cls = AuthenticationError
    elif status == 403:
        cls = PermissionError
    elif status == 429:
        cls = RateLimitError
    elif status >= 500:
        cls = ApiError
    elif status >= 400:
        cls = InvalidRequestError
    return cls(
        str(error.get("message") or f"Paymentsnp API returned HTTP {status}."),
        status=status,
        code=error.get("code"),
        request_id=error.get("request_id") or headers.get("x-request-id"),
        retry_after=int(retry) if retry and retry.isdigit() else None,
    )
