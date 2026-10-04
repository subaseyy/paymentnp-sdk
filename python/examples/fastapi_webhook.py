"""FastAPI webhook endpoint. Read the raw body; a parsed JSON model re-serialises
differently and breaks the signature.

pip install paymentsnp fastapi uvicorn
"""

import os

from fastapi import FastAPI, Header, HTTPException, Request, Response

from paymentsnp import SignatureVerificationError, Webhook

app = FastAPI()


@app.post("/webhooks/paymentsnp", status_code=204)
async def paymentsnp_webhook(request: Request, paymentnp_signature: str = Header(None)):
    try:
        event = Webhook.construct_event(
            await request.body(),
            paymentnp_signature,
            os.environ["PAYMENTSNP_WEBHOOK_SECRET"],
        )
    except SignatureVerificationError:
        raise HTTPException(status_code=400)
    if event["type"] == "payment.succeeded":
        pass  # check amount_minor, mark event["data"]["order_id"] paid once
    return Response(status_code=204)
