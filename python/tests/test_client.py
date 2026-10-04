import json
import os
import re
import sys
import time
import unittest
from decimal import Decimal
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import paymentsnp  # noqa: E402
from paymentsnp import (  # noqa: E402
    ApiError,
    AuthenticationError,
    InvalidRequestError,
    Paymentsnp,
    PaymentsnpError,
    PermissionError,
    RateLimitError,
    SignatureVerificationError,
    Webhook,
    format_npr,
    to_paisa,
)


class Stub:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.requests = []

    def __call__(self, method, url, headers, body, timeout):
        self.requests.append({"method": method, "url": url, "headers": headers, "body": body, "timeout": timeout})
        nxt = self.responses.pop(0)
        if isinstance(nxt, Exception):
            raise nxt
        return nxt


def ok(data, headers=None):
    return 200, headers or {}, json.dumps(data).encode()


def fail(status, code, headers=None):
    body = {"error": {"code": code, "message": "Nope.", "request_id": "req_1"}}
    return status, headers or {}, json.dumps(body).encode()


def client(stub, **kw):
    return Paymentsnp(api_key="np_test_abc", base_url="https://api.test/v1", transport=stub, **kw)


@mock.patch("paymentsnp._client.time.sleep", lambda s: None)
class ClientTest(unittest.TestCase):
    def test_key_prefix_and_environment(self):
        with self.assertRaises(ValueError):
            Paymentsnp(api_key="sk_test_123")
        self.assertEqual(Paymentsnp(api_key="np_live_x").environment, "live")
        self.assertEqual(Paymentsnp(api_key="np_test_x").environment, "test")
        self.assertNotIn("np_test_x", repr(Paymentsnp(api_key="np_test_x")))

    def test_checkout_create(self):
        stub = Stub(ok({"id": "cs_1", "checkout_url": "https://x/c/t"}))
        session = client(stub).checkout.sessions.create({"order_id": "A-1", "amount_minor": 10000, "currency": "NPR"})
        self.assertEqual(session["id"], "cs_1")
        r = stub.requests[0]
        self.assertEqual((r["method"], r["url"]), ("POST", "https://api.test/v1/checkout/sessions"))
        self.assertEqual(json.loads(r["body"]), {"order_id": "A-1", "amount_minor": 10000, "currency": "NPR"})
        self.assertEqual(r["headers"]["Authorization"], "Bearer np_test_abc")
        self.assertEqual(r["headers"]["User-Agent"], "paymentsnp-python/1.0.0")
        self.assertEqual(r["headers"]["Content-Type"], "application/json")
        self.assertEqual(r["timeout"], 30)
        self.assertRegex(r["headers"]["Idempotency-Key"], r"^[0-9a-f-]{36}$")

    def test_create_retries_reuse_key(self):
        stub = Stub(fail(503, "internal_error"), paymentsnp.ConnectionError("reset"), ok({"id": "cs_1"}))
        client(stub).checkout.sessions.create({"order_id": "A"}, idempotency_key="order-A")
        self.assertEqual(len(stub.requests), 3)
        self.assertEqual({r["headers"]["Idempotency-Key"] for r in stub.requests}, {"order-A"})

    def test_post_without_key_not_retried(self):
        stub = Stub(fail(502, "internal_error"), ok({}))
        with self.assertRaises(ApiError):
            client(stub).invoices.finalize("inv_1")
        self.assertEqual(len(stub.requests), 1)
        self.assertEqual(stub.requests[0]["body"], b"{}")

    def test_get_retries_429_then_gives_up(self):
        sleeps = []
        stub = Stub(*[fail(429, "rate_limited", {"retry-after": "7"})] * 3)
        with mock.patch("paymentsnp._client.time.sleep", sleeps.append):
            with self.assertRaises(RateLimitError) as ctx:
                client(stub).payments.list()
        self.assertEqual(len(stub.requests), 3)
        self.assertEqual(sleeps, [7.0, 7.0])
        self.assertEqual(ctx.exception.retry_after, 7)
        self.assertEqual(ctx.exception.code, "rate_limited")

    def test_backoff(self):
        from paymentsnp._client import _backoff

        self.assertEqual(_backoff(0, 3600), 60)
        self.assertTrue(0.25 <= _backoff(0, None) <= 0.5)
        self.assertTrue(1 <= _backoff(2, None) <= 2)

    def test_error_mapping(self):
        cases = [
            (400, "invalid_request", InvalidRequestError),
            (401, "api_key_expired", AuthenticationError),
            (403, "api_key_ip_denied", PermissionError),
            (404, "not_found", InvalidRequestError),
            (409, "idempotency_conflict", InvalidRequestError),
            (500, "internal_error", ApiError),
        ]
        for status, code, cls in cases:
            stub = Stub(fail(status, code), fail(status, code), fail(status, code))
            with self.assertRaises(cls) as ctx:
                client(stub, max_retries=0).payments.retrieve("p_1")
            e = ctx.exception
            self.assertIsInstance(e, PaymentsnpError)
            self.assertEqual((e.status, e.code, e.request_id, e.message), (status, code, "req_1", "Nope."))
            self.assertEqual(len(stub.requests), 1)

    def test_non_json_error_uses_header_request_id(self):
        stub = Stub((502, {"x-request-id": "req_h"}, b"<html>bad gateway</html>"))
        with self.assertRaises(ApiError) as ctx:
            client(stub, max_retries=0).payments.summary()
        self.assertEqual(ctx.exception.request_id, "req_h")

    def test_paths(self):
        stub = Stub(*[ok({"ok": True})] * 18)
        c = client(stub)
        c.checkout.sessions.retrieve("cs/1")
        c.checkout.sessions.expire("cs_1")
        c.payments.list({"limit": 10, "from": "2026-01-01", "to": "2026-01-31"})
        c.payments.retrieve("p_1")
        c.payments.summary()
        c.invoices.list({"status": "open"})
        c.invoices.retrieve("i_1")
        c.invoices.create({"customer": {"email": "a@b.np"}, "line_items": []})
        c.invoices.update("i_1", {"memo": "Hi"})
        c.invoices.finalize("i_1")
        c.invoices.send("i_1", {"channels": ["email"]})
        c.invoices.mark_paid("i_1", {"note": "Cash"})
        c.invoices.void("i_1")
        c.invoices.mark_uncollectible("i_1")
        c.invoices.duplicate("i_1")
        c.reconciliation.list()
        c.reconciliation.import_settlement({"provider": "esewa"})
        c.reconciliation.import_bulk({"records": []})
        got = [f"{r['method']} {r['url'][len('https://api.test/v1'):]}" for r in stub.requests]
        self.assertEqual(
            got,
            [
                "GET /checkout/sessions/cs%2F1",
                "POST /checkout/sessions/cs_1/expire",
                "GET /payments?limit=10&from=2026-01-01&to=2026-01-31",
                "GET /payments/p_1",
                "GET /payments/summary",
                "GET /invoices?status=open",
                "GET /invoices/i_1",
                "POST /invoices",
                "PATCH /invoices/i_1",
                "POST /invoices/i_1/finalize",
                "POST /invoices/i_1/send",
                "POST /invoices/i_1/mark-paid",
                "POST /invoices/i_1/void",
                "POST /invoices/i_1/uncollectible",
                "POST /invoices/i_1/duplicate",
                "GET /reconciliation",
                "POST /reconciliation/import",
                "POST /reconciliation/import/bulk",
            ],
        )
        self.assertIsNone(stub.requests[0]["body"])
        self.assertNotIn("Idempotency-Key", stub.requests[1]["headers"])

    def test_report_and_pdf(self):
        stub = Stub(ok({"period_days": 7}), (200, {"content-type": "application/pdf"}, b"%PDF-1.7\x00\xff"))
        c = client(stub)
        self.assertEqual(c.reconciliation.report({"period": "7"})["period_days"], 7)
        self.assertEqual(c.invoices.pdf("i_1"), b"%PDF-1.7\x00\xff")
        self.assertEqual(stub.requests[0]["url"], "https://api.test/v1/reconciliation/report?period=7")
        self.assertEqual(stub.requests[1]["headers"]["Accept"], "application/pdf")


class WebhookTest(unittest.TestCase):
    secret = "whsec_test"
    body = b'{"id":"evt_1","type":"payment.succeeded","api_version":"v1","environment":"test","created_at":"2026-01-01T00:00:00.000Z","data":{"amount_minor":10000}}'

    def test_round_trip(self):
        header = Webhook.generate_test_header(self.body, self.secret)
        event = Webhook.construct_event(self.body, header, self.secret)
        self.assertEqual(event["type"], "payment.succeeded")
        self.assertEqual(event["data"]["amount_minor"], 10000)
        self.assertEqual(Webhook.construct_event(self.body.decode(), header, self.secret)["id"], "evt_1")

    def test_rejects(self):
        header = Webhook.generate_test_header(self.body, self.secret)
        for body, hdr, secret in [
            (self.body + b" ", header, self.secret),
            (self.body, header, "whsec_other"),
            (self.body, "garbage", self.secret),
            (self.body, None, self.secret),
            (self.body, Webhook.generate_test_header(self.body, self.secret, int(time.time()) - 301), self.secret),
        ]:
            with self.assertRaises(SignatureVerificationError):
                Webhook.construct_event(body, hdr, secret)
        with self.assertRaises(SignatureVerificationError):
            Webhook.construct_event(json.loads(self.body), header, self.secret)

    def test_tolerance_and_vectors(self):
        old = Webhook.generate_test_header(self.body, self.secret, int(time.time()) - 301)
        self.assertEqual(Webhook.construct_event(self.body, old, self.secret, tolerance=0)["id"], "evt_1")
        import hashlib
        import hmac

        expected = hmac.new(b"whsec_test", b"1700000000.{}", hashlib.sha256).hexdigest()
        self.assertEqual(Webhook.generate_test_header("{}", "whsec_test", 1700000000), f"t=1700000000,v1={expected}")
        now = int(time.time())
        good = Webhook.generate_test_header(self.body, self.secret, now).split("v1=")[1]
        self.assertEqual(Webhook.construct_event(self.body, f"t={now},v1=deadbeef,v1={good}", self.secret)["id"], "evt_1")


class MoneyTest(unittest.TestCase):
    def test_to_paisa(self):
        self.assertEqual(to_paisa("1,234.50"), 123450)
        self.assertEqual(to_paisa("1234.5"), 123450)
        self.assertEqual(to_paisa("1,00,000"), 10000000)
        self.assertEqual(to_paisa("0.50"), 50)
        self.assertEqual(to_paisa(25), 2500)
        self.assertEqual(to_paisa(Decimal("19.99")), 1999)
        for bad in ["1.234", "-5", "abc", "", "1.2.3"]:
            with self.assertRaises(ValueError):
                to_paisa(bad)
        with self.assertRaises(TypeError):
            to_paisa(19.99)  # type: ignore[arg-type]

    def test_format_npr(self):
        self.assertEqual(format_npr(123450), "NPR 1,234.50")
        self.assertEqual(format_npr(5), "NPR 0.05")
        self.assertEqual(format_npr(123456700), "NPR 1,234,567.00")
        self.assertEqual(format_npr(-100), "-NPR 1.00")


if __name__ == "__main__":
    unittest.main()
