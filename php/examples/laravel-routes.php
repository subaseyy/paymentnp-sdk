<?php

// routes/web.php (Laravel). composer require paymentsnp/paymentsnp-php
// Exclude the webhook route from CSRF protection (VerifyCsrfToken $except or
// bootstrap/app.php ->validateCsrfTokens(except: ['webhooks/paymentsnp'])).

use Illuminate\Http\Request;
use Illuminate\Support\Facades\Route;
use Paymentsnp\PaymentsnpClient;
use Paymentsnp\SignatureVerificationError;
use Paymentsnp\Webhook;

Route::post('/orders/{order}/pay', function (string $order) {
    $paymentsnp = new PaymentsnpClient(config('services.paymentsnp.key'));
    $session = $paymentsnp->checkout->sessions->create([
        'order_id' => $order,
        'amount_minor' => 125000, // NPR 1,250.00 in paisa
        'currency' => 'NPR',
        'success_url' => url("/orders/{$order}"),
        'cancel_url' => url('/cart'),
    ], ['idempotency_key' => "checkout-{$order}"]);

    return redirect()->away($session['checkout_url']);
});

Route::post('/webhooks/paymentsnp', function (Request $request) {
    try {
        $event = Webhook::constructEvent(
            $request->getContent(), // raw body
            (string) $request->header('Paymentnp-Signature'),
            config('services.paymentsnp.webhook_secret')
        );
    } catch (SignatureVerificationError $e) {
        abort(400);
    }

    if ($event['type'] === 'payment.succeeded') {
        // Look up the order from $event['data'], check amount_minor, mark it
        // paid once (de-duplicate on $event['id']).
    }

    return response()->noContent();
});
