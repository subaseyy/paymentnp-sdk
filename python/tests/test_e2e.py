"""Live end-to-end test against a running Paymentsnp backend (test environment).

Skipped unless PAYMENTSNP_E2E_BASE_URL (e.g. http://localhost:4000/v1) and
PAYMENTSNP_E2E_API_KEY (an np_test_ key with all scopes and the Sandbox gateway
enabled, backend started with ENABLE_SANDBOX_PROVIDER=true) are set.
"""

import json
import os
import sys
import unittest
import urllib.request
import uuid

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from paymentsnp import (  # noqa: E402
    AuthenticationError,
    InvalidRequestError,
    Paymentsnp,
)

BASE = os.environ.get("PAYMENTSNP_E2E_BASE_URL")
KEY = os.environ.get("PAYMENTSNP_E2E_API_KEY")


def public_post(path, body):
    request = urllib.request.Request(
        BASE.rstrip("/") + path, json.dumps(body).encode(), {"content-type": "application/json"}, method="POST"
    )
    with urllib.request.urlopen(request) as response:
        return json.loads(response.read())


@unittest.skipUnless(BASE and KEY, "set PAYMENTSNP_E2E_BASE_URL and PAYMENTSNP_E2E_API_KEY")
class LiveTest(unittest.TestCase):
    def setUp(self):
        self.client = Paymentsnp(api_key=KEY, base_url=BASE)

    def test_checkout_payment_and_errors(self):
        c = self.client
        order = f"py-{uuid.uuid4().hex[:12]}"
        params = {"order_id": order, "amount_minor": 12345, "currency": "NPR", "allowed_methods": ["sandbox"],
                  "customer": {"email": "buyer@example.test", "name": "Buyer"}}
        key = f"order-{order}"
        session = c.checkout.sessions.create(params, idempotency_key=key)
        self.assertEqual(session["status"], "open")
        self.assertEqual(session["amount_minor"], 12345)
        self.assertIn("/c/", session["checkout_url"])
        # Idempotent replay returns the same session; a different body conflicts.
        self.assertEqual(c.checkout.sessions.create(params, idempotency_key=key)["id"], session["id"])
        with self.assertRaises(InvalidRequestError) as ctx:
            c.checkout.sessions.create({**params, "amount_minor": 1}, idempotency_key=key)
        self.assertEqual((ctx.exception.status, ctx.exception.code), (409, "idempotency_conflict"))
        self.assertTrue(ctx.exception.request_id)
        self.assertEqual(c.checkout.sessions.retrieve(session["id"])["order_id"], order)

        # Pay it through the public sandbox flow, then read the payment back.
        token = session["checkout_url"].rsplit("/", 1)[1]
        public_post(f"/checkout/public/{token}/attempts", {"provider": "sandbox"})
        public_post(f"/checkout/public/{token}/simulate", {"outcome": "succeeded"})
        self.assertEqual(c.checkout.sessions.retrieve(session["id"])["status"], "paid")
        payments = c.payments.list({"search": order})
        self.assertEqual(len(payments["data"]), 1)
        payment = c.payments.retrieve(payments["data"][0]["id"])
        self.assertEqual((payment["order_id"], payment["amount_minor"], payment["is_simulated"]), (order, 12345, True))
        summary = c.payments.summary()
        self.assertEqual(summary["environment"], "test")
        self.assertFalse(summary["is_balance"])

        # Reconcile that payment.
        record = {"provider": "sandbox", "settlement_reference": f"SET-{order}",
                  "provider_transaction_id": payment["provider_transaction_id"],
                  "settled_amount_minor": 12345, "settled_at": "2026-01-02T10:00:00+05:45"}
        self.assertEqual(c.reconciliation.import_settlement(record)["status"], "matched")
        with self.assertRaises(InvalidRequestError) as ctx:
            c.reconciliation.import_settlement(record)
        self.assertEqual(ctx.exception.code, "duplicate_settlement")
        bulk = c.reconciliation.import_bulk({"records": [record, {"provider": "esewa"}]})
        self.assertEqual([r["status"] for r in bulk["results"]], ["duplicate", "invalid"])
        self.assertTrue(any(r["settlement_reference"] == f"SET-{order}" for r in c.reconciliation.list({"limit": 100})["data"]))
        self.assertEqual(c.reconciliation.report({"period": "7"})["period_days"], 7)

        # A second session can be expired.
        other = c.checkout.sessions.create({**params, "order_id": order + "-x"})
        self.assertEqual(c.checkout.sessions.expire(other["id"])["status"], "expired")

        with self.assertRaises(InvalidRequestError) as ctx:
            c.checkout.sessions.create({**params, "amount_minor": 0})
        self.assertEqual((ctx.exception.status, ctx.exception.code), (400, "invalid_request"))
        with self.assertRaises(InvalidRequestError) as ctx:
            c.payments.retrieve(str(uuid.uuid4()))
        self.assertEqual(ctx.exception.status, 404)
        with self.assertRaises(AuthenticationError):
            Paymentsnp(api_key="np_test_" + "x" * 40, base_url=BASE, max_retries=0).payments.list()

    def test_invoice_lifecycle(self):
        c = self.client
        draft = c.invoices.create({
            "customer": {"email": "invoice@example.test", "name": "Invoice Buyer"},
            "line_items": [{"description": "Hosting", "quantity": 2, "unit_amount_minor": 50000}],
        })
        self.assertEqual(draft["status"], "draft")
        updated = c.invoices.update(draft["id"], {
            "customer": {"email": "invoice@example.test", "name": "Invoice Buyer"},
            "line_items": [{"description": "Hosting", "quantity": 3, "unit_amount_minor": 50000}],
            "memo": "Thanks",
        })
        self.assertEqual(updated["memo"], "Thanks")
        opened = c.invoices.finalize(draft["id"])
        self.assertEqual(opened["status"], "open")
        self.assertEqual(c.invoices.retrieve(draft["id"])["id"], draft["id"])
        self.assertTrue(any(i["id"] == draft["id"] for i in c.invoices.list({"status": "open"})["data"]))
        try:
            c.invoices.send(draft["id"], {"channels": ["email"]})
        except InvalidRequestError as error:  # local backends usually have no SMTP
            self.assertIn("SMTP", error.message)
        self.assertEqual(c.invoices.mark_uncollectible(draft["id"])["status"], "uncollectible")
        self.assertEqual(c.invoices.mark_paid(draft["id"], {"note": "Paid in cash"})["status"], "paid")
        self.assertTrue(c.invoices.pdf(draft["id"]).startswith(b"%PDF"))
        copy = c.invoices.duplicate(draft["id"])
        self.assertEqual(copy["status"], "draft")
        self.assertEqual(c.invoices.void(copy["id"])["status"], "void")


if __name__ == "__main__":
    unittest.main()
