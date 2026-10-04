<?php

// Create a hosted checkout and redirect the customer to it.
// Composer: require __DIR__ . '/vendor/autoload.php';  Without Composer:
require_once __DIR__ . '/../init.php';

use Paymentsnp\Money;
use Paymentsnp\PaymentsnpClient;
use Paymentsnp\PaymentsnpError;

$paymentsnp = new PaymentsnpClient(getenv('PAYMENTSNP_API_KEY'));

$orderId = 'ORD-1001';
try {
    $session = $paymentsnp->checkout->sessions->create(array(
        'order_id' => $orderId,
        'amount_minor' => Money::toPaisa('1,250.00'), // 125000 paisa
        'currency' => 'NPR',
        'description' => 'Annual hosting',
        'customer' => array('email' => 'buyer@example.com', 'name' => 'Sita Sharma'),
        'success_url' => 'https://shop.example.com/orders/' . $orderId . '/thanks',
        'cancel_url' => 'https://shop.example.com/cart',
        'metadata' => array('cart_id' => '42'),
    ), array(
        // Same key for the same order: a retried request returns the same session.
        'idempotency_key' => 'checkout-' . $orderId,
    ));
} catch (PaymentsnpError $error) {
    http_response_code(502);
    echo 'Could not start checkout: ' . $error->getMessage() . ' (' . $error->getRequestId() . ')';
    exit;
}

// The return to success_url is not proof of payment: wait for the
// payment.succeeded webhook (see webhook.php) or retrieve the session.
header('Location: ' . $session['checkout_url'], true, 303);
