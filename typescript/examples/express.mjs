// Express: checkout + webhook. Run: PAYMENTSNP_API_KEY=np_test_... \
//   PAYMENTSNP_WEBHOOK_SECRET=whsec_... node examples/express.mjs
import express from "express";
import { Paymentsnp, SignatureVerificationError, toPaisa } from "@paymentsnp/sdk";

const pnp = new Paymentsnp({ apiKey: process.env.PAYMENTSNP_API_KEY });
const app = express();

// The webhook route needs the raw bytes, so register express.raw() on it
// BEFORE any global express.json().
app.post(
  "/webhooks/paymentsnp",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      const event = await Paymentsnp.webhooks.constructEvent(
        req.body, // Buffer (a Uint8Array)
        req.get("Paymentnp-Signature"),
        process.env.PAYMENTSNP_WEBHOOK_SECRET,
      );
      if (event.type === "payment.succeeded")
        console.log("paid", event.data.order_id, event.data.amount_minor);
      res.sendStatus(204);
    } catch (error) {
      if (error instanceof SignatureVerificationError) return res.sendStatus(400);
      throw error;
    }
  },
);

app.use(express.json());
app.post("/checkout", async (req, res, next) => {
  try {
    const session = await pnp.checkout.sessions.create(
      {
        order_id: req.body.order_id,
        amount_minor: toPaisa(req.body.amount),
        currency: "NPR",
      },
      { idempotencyKey: `checkout-${req.body.order_id}` },
    );
    res.redirect(303, session.checkout_url);
  } catch (error) {
    next(error);
  }
});

app.listen(3000, () => console.log("listening on :3000"));
