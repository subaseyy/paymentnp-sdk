"""Django views: start a checkout and receive webhooks.

urls.py:
    path("orders/<str:order_id>/pay", views.pay),
    path("webhooks/paymentsnp", views.paymentsnp_webhook),
settings.py: PAYMENTSNP_API_KEY, PAYMENTSNP_WEBHOOK_SECRET
"""

from django.conf import settings
from django.http import HttpResponse, HttpResponseBadRequest, HttpResponseRedirect
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_POST

from paymentsnp import Paymentsnp, SignatureVerificationError, Webhook

paymentsnp = Paymentsnp(api_key=settings.PAYMENTSNP_API_KEY)


@require_POST
def pay(request, order_id):
    session = paymentsnp.checkout.sessions.create(
        {
            "order_id": order_id,
            "amount_minor": 125000,  # NPR 1,250.00 in paisa
            "currency": "NPR",
            "success_url": request.build_absolute_uri(f"/orders/{order_id}"),
            "cancel_url": request.build_absolute_uri("/cart"),
        },
        idempotency_key=f"checkout-{order_id}",
    )
    return HttpResponseRedirect(session["checkout_url"])


@csrf_exempt
@require_POST
def paymentsnp_webhook(request):
    try:
        event = Webhook.construct_event(
            request.body,  # raw bytes
            request.headers.get("Paymentnp-Signature"),
            settings.PAYMENTSNP_WEBHOOK_SECRET,
        )
    except SignatureVerificationError:
        return HttpResponseBadRequest()
    if event["type"] == "payment.succeeded":
        pass  # check amount_minor, mark event["data"]["order_id"] paid once
    return HttpResponse(status=204)
