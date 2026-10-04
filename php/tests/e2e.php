<?php

// Live end-to-end test against a running Paymentsnp backend (test environment).
// Loaded by tests/run.php only when PAYMENTSNP_E2E_BASE_URL (e.g.
// http://localhost:4000/v1) and PAYMENTSNP_E2E_API_KEY (an np_test_ key with
// all scopes, Sandbox gateway enabled, ENABLE_SANDBOX_PROVIDER=true) are set.

use Paymentsnp\AuthenticationError;
use Paymentsnp\InvalidRequestError;
use Paymentsnp\PaymentsnpClient;

function e2eClient()
{
    return new PaymentsnpClient(getenv('PAYMENTSNP_E2E_API_KEY'), array('base_url' => getenv('PAYMENTSNP_E2E_BASE_URL')));
}

function e2ePublicPost($path, array $body)
{
    $handle = curl_init(rtrim(getenv('PAYMENTSNP_E2E_BASE_URL'), '/') . $path);
    curl_setopt_array($handle, array(
        CURLOPT_POST => true,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => array('Content-Type: application/json'),
        CURLOPT_POSTFIELDS => json_encode($body),
    ));
    $raw = curl_exec($handle);
    $status = curl_getinfo($handle, CURLINFO_HTTP_CODE);
    curl_close($handle);
    if ($status >= 300) {
        throw new RuntimeException('Public call ' . $path . ' failed with HTTP ' . $status);
    }
    return json_decode($raw, true);
}

test('e2e: checkout, sandbox payment, payments, reconciliation, errors', function () {
    $c = e2eClient();
    $order = 'php-' . bin2hex(random_bytes(6));
    $params = array(
        'order_id' => $order,
        'amount_minor' => 12345,
        'currency' => 'NPR',
        'allowed_methods' => array('sandbox'),
        'customer' => array('email' => 'buyer@example.test', 'name' => 'Buyer'),
    );
    $key = 'order-' . $order;
    $session = $c->checkout->sessions->create($params, array('idempotency_key' => $key));
    same('open', $session['status']);
    same(12345, $session['amount_minor']);
    same($session['id'], $c->checkout->sessions->create($params, array('idempotency_key' => $key))['id']);
    $conflict = throws(InvalidRequestError::class, function () use ($c, $params, $key) {
        $c->checkout->sessions->create(array_merge($params, array('amount_minor' => 1)), array('idempotency_key' => $key));
    });
    same(409, $conflict->getStatus());
    same('idempotency_conflict', $conflict->getErrorCode());
    same($order, $c->checkout->sessions->retrieve($session['id'])['order_id']);

    $parts = explode('/', $session['checkout_url']);
    $token = end($parts);
    e2ePublicPost('/checkout/public/' . $token . '/attempts', array('provider' => 'sandbox'));
    e2ePublicPost('/checkout/public/' . $token . '/simulate', array('outcome' => 'succeeded'));
    same('paid', $c->checkout->sessions->retrieve($session['id'])['status']);
    $list = $c->payments->list(array('search' => $order));
    same(1, count($list['data']));
    $payment = $c->payments->retrieve($list['data'][0]['id']);
    same(12345, $payment['amount_minor']);
    same(true, $payment['is_simulated']);
    same(false, $c->payments->summary()['is_balance']);

    $record = array(
        'provider' => 'sandbox',
        'settlement_reference' => 'SET-' . $order,
        'provider_transaction_id' => $payment['provider_transaction_id'],
        'settled_amount_minor' => 12345,
        'settled_at' => '2026-01-02T10:00:00+05:45',
    );
    same('matched', $c->reconciliation->importSettlement($record)['status']);
    same('duplicate_settlement', throws(InvalidRequestError::class, function () use ($c, $record) {
        $c->reconciliation->importSettlement($record);
    })->getErrorCode());
    $bulk = $c->reconciliation->importBulk(array('records' => array($record, array('provider' => 'esewa'))));
    same(array('duplicate', 'invalid'), array_column($bulk['results'], 'status'));
    same(7, $c->reconciliation->report(array('period' => '7'))['period_days']);
    same(true, in_array('SET-' . $order, array_column($c->reconciliation->list(array('limit' => 100))['data'], 'settlement_reference'), true));

    $other = $c->checkout->sessions->create(array_merge($params, array('order_id' => $order . '-x')));
    same('expired', $c->checkout->sessions->expire($other['id'])['status']);

    same('invalid_request', throws(InvalidRequestError::class, function () use ($c, $params) {
        $c->checkout->sessions->create(array_merge($params, array('amount_minor' => 0)));
    })->getErrorCode());
    same(404, throws(InvalidRequestError::class, function () use ($c) {
        $c->payments->retrieve(PaymentsnpClient::uuid());
    })->getStatus());
    throws(AuthenticationError::class, function () {
        (new PaymentsnpClient('np_test_' . str_repeat('x', 40), array('base_url' => getenv('PAYMENTSNP_E2E_BASE_URL'), 'max_retries' => 0)))->payments->list();
    });
});

test('e2e: invoice lifecycle and PDF', function () {
    $c = e2eClient();
    $customer = array('email' => 'invoice@example.test', 'name' => 'Invoice Buyer');
    $draft = $c->invoices->create(array(
        'customer' => $customer,
        'line_items' => array(array('description' => 'Hosting', 'quantity' => 2, 'unit_amount_minor' => 50000)),
    ));
    same('draft', $draft['status']);
    same('Thanks', $c->invoices->update($draft['id'], array(
        'customer' => $customer,
        'line_items' => array(array('description' => 'Hosting', 'quantity' => 3, 'unit_amount_minor' => 50000)),
        'memo' => 'Thanks',
    ))['memo']);
    same('open', $c->invoices->finalize($draft['id'])['status']);
    same($draft['id'], $c->invoices->retrieve($draft['id'])['id']);
    same(true, in_array($draft['id'], array_column($c->invoices->list(array('status' => 'open'))['data'], 'id'), true));
    try {
        $c->invoices->send($draft['id'], array('channels' => array('email')));
    } catch (InvalidRequestError $error) { // local backends usually have no SMTP
        same(true, strpos($error->getMessage(), 'SMTP') !== false);
    }
    same('uncollectible', $c->invoices->markUncollectible($draft['id'])['status']);
    same('paid', $c->invoices->markPaid($draft['id'], array('note' => 'Paid in cash'))['status']);
    same('%PDF', substr($c->invoices->pdf($draft['id']), 0, 4));
    $copy = $c->invoices->duplicate($draft['id']);
    same('draft', $copy['status']);
    same('void', $c->invoices->void($copy['id'])['status']);
});
