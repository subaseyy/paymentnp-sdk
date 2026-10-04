from __future__ import annotations

import hashlib
import hmac
import json
import time
from typing import Optional, Union, cast

from ._errors import SignatureVerificationError
from .types import WebhookEvent

DEFAULT_TOLERANCE = 300


def _sign(timestamp: int, body: bytes, secret: str) -> str:
    return hmac.new(secret.encode("utf-8"), str(timestamp).encode() + b"." + body, hashlib.sha256).hexdigest()


def _bytes(body: Union[bytes, bytearray, str]) -> bytes:
    if isinstance(body, str):
        return body.encode("utf-8")
    if isinstance(body, (bytes, bytearray)):
        return bytes(body)
    raise SignatureVerificationError("Pass the raw request body (bytes or str), not parsed JSON.")


class Webhook:
    """Webhook signature verification.

    Paymentsnp signs each delivery with
    ``Paymentnp-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>``
    and sends the event id in ``Paymentnp-Event-Id`` (use it to de-duplicate).
    """

    @staticmethod
    def construct_event(
        raw_body: Union[bytes, bytearray, str],
        signature_header: Optional[str],
        secret: str,
        tolerance: int = DEFAULT_TOLERANCE,
    ) -> WebhookEvent:
        """Verify the signature over the exact raw body and return the event dict.

        ``tolerance`` is the max timestamp age in seconds (0 disables the check).
        Raises SignatureVerificationError.
        """
        body = _bytes(raw_body)
        if not secret:
            raise SignatureVerificationError("The webhook secret is required.")
        timestamp: Optional[int] = None
        signatures = []
        for part in (signature_header or "").split(","):
            key, sep, value = part.strip().partition("=")
            if not sep:
                continue
            if key == "t" and value.isdigit():
                timestamp = int(value)
            elif key == "v1":
                signatures.append(value)
        if timestamp is None or not signatures:
            raise SignatureVerificationError("Missing or malformed Paymentnp-Signature header.")
        expected = _sign(timestamp, body, secret)
        # Compare against every v1 value without short-circuiting.
        matched = [hmac.compare_digest(expected, s) for s in signatures]
        if not any(matched):
            raise SignatureVerificationError("Webhook signature does not match the payload.")
        if tolerance > 0 and abs(time.time() - timestamp) > tolerance:
            raise SignatureVerificationError("Webhook timestamp is outside the tolerance window.")
        try:
            event = json.loads(body.decode("utf-8"))
        except ValueError:
            raise SignatureVerificationError("Webhook body is not valid JSON.") from None
        if not isinstance(event, dict):
            raise SignatureVerificationError("Webhook body is not a JSON object.")
        return cast(WebhookEvent, event)

    @staticmethod
    def generate_test_header(
        body: Union[bytes, bytearray, str], secret: str, timestamp: Optional[int] = None
    ) -> str:
        """Build a ``Paymentnp-Signature`` value, for testing your handler."""
        ts = int(time.time()) if timestamp is None else int(timestamp)
        return f"t={ts},v1={_sign(ts, _bytes(body), secret)}"
