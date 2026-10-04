// Next.js App Router: create a hosted checkout and send the browser there.
// POST /api/checkout  { "order_id": "ORD-1001", "amount": "1500.00" }
import { NextResponse } from "next/server";
import { InvalidRequestError, Paymentsnp, toPaisa } from "@paymentsnp/sdk";

const pnp = new Paymentsnp({ apiKey: process.env.PAYMENTSNP_API_KEY! });

export async function POST(request: Request) {
  const { order_id, amount } = (await request.json()) as {
    order_id: string;
    amount: string;
  };
  try {
    const session = await pnp.checkout.sessions.create(
      {
        order_id,
        amount_minor: toPaisa(amount),
        currency: "NPR",
        description: `Order ${order_id}`,
        // Both origins must be in Settings -> Return origins.
        success_url: `${process.env.SITE_URL}/orders/${order_id}/thanks`,
        cancel_url: `${process.env.SITE_URL}/cart`,
      },
      // Same order -> same key, so a double click returns the same session.
      { idempotencyKey: `checkout-${order_id}` },
    );
    return NextResponse.json({ checkout_url: session.checkout_url });
  } catch (error) {
    if (error instanceof InvalidRequestError)
      return NextResponse.json({ error: error.message }, { status: 400 });
    throw error;
  }
}
