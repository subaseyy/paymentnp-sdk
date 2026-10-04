<?php

// Plain PHP webhook endpoint. Register its https:// URL under
// Dashboard -> Webhooks and keep the whsec_ secret in an environment variable.
require_once __DIR__ . '/../init.php';

use Paymentsnp\SignatureVerificationError;
use Paymentsnp\Webhook;

$payload = file_get_contents('php://input'); // the raw body, before any JSON parsing
$signature = isset($_SERVER['HTTP_PAYMENTNP_SIGNATURE']) ? $_SERVER['HTTP_PAYMENTNP_SIGNATURE'] : '';

try {
    $event = Webhook::constructEvent($payload, $signature, getenv('PAYMENTSNP_WEBHOOK_SECRET'));
} catch (SignatureVerificationError $error) {
    http_response_code(400);
    exit;
}

// Deliveries are retried, so handle each event id once
// ($_SERVER['HTTP_PAYMENTNP_EVENT_ID'] equals $event['id']).
switch ($event['type']) {
    case 'payment.succeeded':
        // $event['data'] has the order and amount; mark the order paid if the
        // amount_minor matches what you expect.
        break;
    case 'payment.failed':
    case 'checkout.expired':
        break;
    case 'webhook.test':
        break;
}

http_response_code(200); // any 2xx; redirects count as failures
