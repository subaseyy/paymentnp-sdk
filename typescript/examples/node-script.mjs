// Plain Node 18+ script: create a checkout, then print recent payments.
// PAYMENTSNP_API_KEY=np_test_... node examples/node-script.mjs
import { Paymentsnp, PaymentsnpError, formatNpr, toPaisa } from "@paymentsnp/sdk";

const pnp = new Paymentsnp({ apiKey: process.env.PAYMENTSNP_API_KEY });

try {
  const session = await pnp.checkout.sessions.create({
    order_id: `ORD-${Date.now()}`,
    amount_minor: toPaisa("1,500.00"),
    currency: "NPR",
    customer: { email: "buyer@example.com", name: "Buyer" },
  });
  console.log(`Pay ${formatNpr(session.amount_minor)} at ${session.checkout_url}`);

  const { data } = await pnp.payments.list({ limit: 5 });
  for (const p of data)
    console.log(p.verified_at, p.order_id, p.provider, formatNpr(p.amount_minor));
} catch (error) {
  if (error instanceof PaymentsnpError)
    console.error(`${error.name} ${error.code} (request ${error.requestId}): ${error.message}`);
  else throw error;
  process.exitCode = 1;
}
