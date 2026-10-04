// Next.js App Router webhook endpoint. Read the RAW body with
// request.text(); never verify a re-serialised JSON object.
import { Paymentsnp, SignatureVerificationError } from "@paymentsnp/sdk";

export async function POST(request: Request) {
  const body = await request.text();
  let event;
  try {
    event = await Paymentsnp.webhooks.constructEvent(
      body,
      request.headers.get("paymentnp-signature"),
      process.env.PAYMENTSNP_WEBHOOK_SECRET!,
    );
  } catch (error) {
    if (error instanceof SignatureVerificationError)
      return new Response("invalid signature", { status: 400 });
    throw error;
  }

  // Deliveries can repeat: dedupe on event.id (also in Paymentnp-Event-Id).
  switch (event.type) {
    case "payment.succeeded":
      // Mark event.data.order_id paid for event.data.amount_minor paisa.
      // Check the amount against your order before fulfilling.
      break;
    case "payment.failed":
      // The customer may try again on the same checkout.
      break;
    case "checkout.expired":
      break;
    case "webhook.test":
      break;
  }
  return new Response(null, { status: 204 });
}
