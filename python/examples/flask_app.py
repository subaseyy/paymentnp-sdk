"""Flask: start a checkout and receive webhooks.

pip install paymentsnp flask
PAYMENTSNP_API_KEY=np_test_... PAYMENTSNP_WEBHOOK_SECRET=whsec_... flask --app flask_app run
"""

import os

from flask import Flask, abort, redirect, request

from paymentsnp import Paymentsnp, PaymentsnpError, SignatureVerificationError, Webhook, to_paisa

app = Flask(__name__)
paymentsnp = Paymentsnp(api_key=os.environ["PAYMENTSNP_API_KEY"])


@app.post("/orders/<order_id>/pay")
def pay(order_id: str):
    try:
        session = paymentsnp.checkout.sessions.create(
            {
                "order_id": order_id,
                "amount_minor": to_paisa("1,250.00"),  # 125000 paisa
                "currency": "NPR",
                "customer": {"email": "buyer@example.com", "name": "Sita Sharma"},
                "success_url": f"https://shop.example.com/orders/{order_id}",
                "cancel_url": "https://shop.example.com/cart",
            },
            # Same key for the same order: a retried request returns the same session.
            idempotency_key=f"checkout-{order_id}",
        )
    except PaymentsnpError as error:
        abort(502, f"Could not start checkout: {error.message} ({error.request_id})")
    return redirect(session["checkout_url"], code=303)


@app.post("/webhooks/paymentsnp")
def webhook():
    try:
        event = Webhook.construct_event(
            request.get_data(),  # raw bytes, not request.json
            request.headers.get("Paymentnp-Signature"),
            os.environ["PAYMENTSNP_WEBHOOK_SECRET"],
        )
    except SignatureVerificationError:
        abort(400)
    if event["type"] == "payment.succeeded":
        data = event["data"]
        # Check data["amount_minor"] against your order, then mark data["order_id"]
        # paid once (deliveries are retried; de-duplicate on event["id"]).
    return "", 204
