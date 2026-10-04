<?php

// Plain PHP tests with a stub transport. Run: php tests/run.php
// The live e2e test (tests/e2e.php) runs when PAYMENTSNP_E2E_BASE_URL and
// PAYMENTSNP_E2E_API_KEY are set.

require_once __DIR__ . '/../init.php';

use Paymentsnp\ApiError;
use Paymentsnp\AuthenticationError;
use Paymentsnp\ConnectionError;
use Paymentsnp\HttpClient;
use Paymentsnp\InvalidRequestError;
use Paymentsnp\Money;
use Paymentsnp\PaymentsnpClient;
use Paymentsnp\PaymentsnpError;
use Paymentsnp\PermissionError;
use Paymentsnp\RateLimitError;
use Paymentsnp\SignatureVerificationError;
use Paymentsnp\Webhook;

$tests = array();
function test($name, callable $callback)
{
    global $tests;
    $tests[] = array($name, $callback);
}
function same($expected, $actual)
{
    if ($expected !== $actual) {
        throw new RuntimeException('Expected ' . var_export($expected, true) . ', got ' . var_export($actual, true));
    }
}
function throws($class, callable $callback)
{
    try {
        $callback();
    } catch (Exception $exception) {
        if ($exception instanceof $class) {
            return $exception;
        }
        throw new RuntimeException('Expected ' . $class . ', got ' . get_class($exception) . ': ' . $exception->getMessage());
    }
    throw new RuntimeException('Expected ' . $class);
}

class StubHttp implements HttpClient
{
    public $requests = array();
    public $responses;

    public function __construct(array $responses)
    {
        $this->responses = $responses;
    }

    public function request($method, $url, array $headers, $body, $timeout)
    {
        $this->requests[] = compact('method', 'url', 'headers', 'body', 'timeout');
        $next = array_shift($this->responses);
        if ($next instanceof Exception) {
            throw $next;
        }
        return $next;
    }

    public function header($index, $name)
    {
        foreach ($this->requests[$index]['headers'] as $line) {
            if (stripos($line, $name . ':') === 0) {
                return trim(substr($line, strlen($name) + 1));
            }
        }
        return null;
    }
}
function ok($data, $headers = array())
{
    return array(200, $headers, json_encode($data));
}
function fail($status, $code, $headers = array())
{
    return array($status, $headers, json_encode(array('error' => array('code' => $code, 'message' => 'Nope.', 'request_id' => 'req_1'))));
}
function client(StubHttp $http, array $options = array())
{
    return new PaymentsnpClient('np_test_abc', $options + array('http_client' => $http, 'base_url' => 'https://api.test/v1'));
}

test('rejects keys without the np_test_/np_live_ prefix', function () {
    throws('InvalidArgumentException', function () {
        new PaymentsnpClient('sk_test_123');
    });
    same('live', (new PaymentsnpClient(array('api_key' => 'np_live_x')))->environment);
    same('test', (new PaymentsnpClient('np_test_x'))->environment);
});

test('checkout create sends JSON, auth, user agent and a generated idempotency key', function () {
    $http = new StubHttp(array(ok(array('id' => 'cs_1', 'checkout_url' => 'https://x/c/t'))));
    $session = client($http)->checkout->sessions->create(array('order_id' => 'A-1', 'amount_minor' => 10000, 'currency' => 'NPR'));
    same('cs_1', $session['id']);
    $request = $http->requests[0];
    same('POST', $request['method']);
    same('https://api.test/v1/checkout/sessions', $request['url']);
    same('{"order_id":"A-1","amount_minor":10000,"currency":"NPR"}', $request['body']);
    same('Bearer np_test_abc', $http->header(0, 'Authorization'));
    same('paymentsnp-php/1.0.0', $http->header(0, 'User-Agent'));
    same(30, $request['timeout']);
    same(1, preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/', $http->header(0, 'Idempotency-Key')));
});

test('checkout create retries 5xx and reuses the same idempotency key', function () {
    $http = new StubHttp(array(fail(503, 'internal_error', array('retry-after' => '0')), new ConnectionError('reset'), ok(array('id' => 'cs_1'))));
    client($http)->checkout->sessions->create(array('order_id' => 'A-1'), array('idempotency_key' => 'order-A-1'));
    same(3, count($http->requests));
    same('order-A-1', $http->header(0, 'Idempotency-Key'));
    same('order-A-1', $http->header(2, 'Idempotency-Key'));
});

test('POST without an idempotency key is never retried', function () {
    $http = new StubHttp(array(fail(502, 'internal_error'), ok(array())));
    throws(ApiError::class, function () use ($http) {
        client($http)->invoices->finalize('inv_1');
    });
    same(1, count($http->requests));
    same('{}', $http->requests[0]['body']);
});

test('GET retries 429 honouring Retry-After, then gives up after max_retries', function () {
    $http = new StubHttp(array(fail(429, 'rate_limited', array('retry-after' => '0')), fail(429, 'rate_limited', array('retry-after' => '0')), fail(429, 'rate_limited', array('retry-after' => '0'))));
    $error = throws(RateLimitError::class, function () use ($http) {
        client($http)->payments->list();
    });
    same(3, count($http->requests));
    same(0, $error->retryAfter);
    same('rate_limited', $error->getErrorCode());
});

test('4xx errors map to typed errors with code and request id, no retry', function () {
    $cases = array(
        array(400, 'invalid_request', InvalidRequestError::class),
        array(401, 'api_key_expired', AuthenticationError::class),
        array(403, 'insufficient_scope', PermissionError::class),
        array(404, 'not_found', InvalidRequestError::class),
        array(409, 'idempotency_conflict', InvalidRequestError::class),
    );
    foreach ($cases as $case) {
        $http = new StubHttp(array(fail($case[0], $case[1])));
        $error = throws($case[2], function () use ($http) {
            client($http)->payments->retrieve('p_1');
        });
        same($case[0], $error->getStatus());
        same($case[1], $error->getErrorCode());
        same('req_1', $error->getRequestId());
        same('Nope.', $error->getMessage());
        same(1, count($http->requests));
        if (!$error instanceof PaymentsnpError) {
            throw new RuntimeException('not a PaymentsnpError');
        }
    }
});

test('Retry-After is capped at 60 seconds and backoff grows', function () {
    $client = client(new StubHttp(array()));
    same(60, $client->delay(0, 3600));
    same(5, $client->delay(0, 5));
    $first = $client->delay(0);
    $third = $client->delay(2);
    if ($first < 0.25 || $first > 0.5 || $third < 1 || $third > 2) {
        throw new RuntimeException('Unexpected backoff ' . $first . ' / ' . $third);
    }
});

test('max_retries 0 disables retries', function () {
    $http = new StubHttp(array(new ConnectionError('down')));
    throws(ConnectionError::class, function () use ($http) {
        client($http, array('max_retries' => 0))->checkout->sessions->retrieve('cs_1');
    });
    same(1, count($http->requests));
});

test('resource paths, query strings and bodies match the API', function () {
    $http = new StubHttp(array_fill(0, 18, ok(array('ok' => true))));
    $c = client($http);
    $c->checkout->sessions->retrieve('cs/1');
    $c->checkout->sessions->expire('cs_1');
    $c->payments->list(array('limit' => 10, 'from' => '2026-01-01', 'to' => '2026-01-31'));
    $c->payments->retrieve('p_1');
    $c->payments->summary();
    $c->invoices->list(array('status' => 'open'));
    $c->invoices->retrieve('i_1');
    $c->invoices->create(array('customer' => array('email' => 'a@b.np'), 'line_items' => array(array('description' => 'X', 'quantity' => 1, 'unit_amount_minor' => 100))));
    $c->invoices->update('i_1', array('memo' => 'Hi'));
    $c->invoices->finalize('i_1');
    $c->invoices->send('i_1', array('channels' => array('email')));
    $c->invoices->markPaid('i_1', array('note' => 'Cash'));
    $c->invoices->void('i_1');
    $c->invoices->markUncollectible('i_1');
    $c->invoices->duplicate('i_1');
    $c->reconciliation->list();
    $c->reconciliation->importSettlement(array('provider' => 'esewa'));
    $c->reconciliation->importBulk(array('records' => array()));
    $got = array_map(function ($r) {
        return $r['method'] . ' ' . substr($r['url'], strlen('https://api.test/v1'));
    }, $http->requests);
    same(array(
        'GET /checkout/sessions/cs%2F1',
        'POST /checkout/sessions/cs_1/expire',
        'GET /payments?limit=10&from=2026-01-01&to=2026-01-31',
        'GET /payments/p_1',
        'GET /payments/summary',
        'GET /invoices?status=open',
        'GET /invoices/i_1',
        'POST /invoices',
        'PATCH /invoices/i_1',
        'POST /invoices/i_1/finalize',
        'POST /invoices/i_1/send',
        'POST /invoices/i_1/mark-paid',
        'POST /invoices/i_1/void',
        'POST /invoices/i_1/uncollectible',
        'POST /invoices/i_1/duplicate',
        'GET /reconciliation',
        'POST /reconciliation/import',
        'POST /reconciliation/import/bulk',
    ), $got);
    same('{"memo":"Hi"}', $http->requests[8]['body']);
    same(null, $http->requests[0]['body']);
    same(null, $http->header(1, 'Idempotency-Key'));
});

test('reconciliation report and invoice pdf', function () {
    $http = new StubHttp(array(ok(array('period_days' => 7)), array(200, array('content-type' => 'application/pdf'), "%PDF-1.7\x00\xff")));
    $c = client($http);
    same(7, $c->reconciliation->report(array('period' => '7'))['period_days']);
    same("%PDF-1.7\x00\xff", $c->invoices->pdf('i_1'));
    same('https://api.test/v1/reconciliation/report?period=7', $http->requests[0]['url']);
    same('application/pdf', $http->header(1, 'Accept'));
});

test('webhook constructEvent verifies, rejects tampering and stale timestamps', function () {
    $secret = 'whsec_test';
    $body = '{"id":"evt_1","type":"payment.succeeded","api_version":"v1","environment":"test","created_at":"2026-01-01T00:00:00.000Z","data":{"amount_minor":10000}}';
    $header = Webhook::generateTestHeader($body, $secret);
    $event = Webhook::constructEvent($body, $header, $secret);
    same('payment.succeeded', $event['type']);
    same(10000, $event['data']['amount_minor']);
    throws(SignatureVerificationError::class, function () use ($body, $header) {
        Webhook::constructEvent($body . ' ', $header, 'whsec_test');
    });
    throws(SignatureVerificationError::class, function () use ($body, $header) {
        Webhook::constructEvent($body, $header, 'whsec_other');
    });
    throws(SignatureVerificationError::class, function () use ($body) {
        Webhook::constructEvent($body, 'garbage', 'whsec_test');
    });
    $old = Webhook::generateTestHeader($body, $secret, time() - 301);
    throws(SignatureVerificationError::class, function () use ($body, $old) {
        Webhook::constructEvent($body, $old, 'whsec_test');
    });
    same('evt_1', Webhook::constructEvent($body, $old, $secret, 0)['id']);
    // Known vector: HMAC-SHA256("whsec_test", "1700000000.{}")
    same('t=1700000000,v1=' . hash_hmac('sha256', '1700000000.{}', 'whsec_test'), Webhook::generateTestHeader('{}', 'whsec_test', 1700000000));
    // Multiple v1 values (e.g. during a secret roll) match if any one does.
    $multi = 't=' . time() . ',v1=deadbeef,v1=' . hash_hmac('sha256', time() . '.' . $body, $secret);
    same('evt_1', Webhook::constructEvent($body, $multi, $secret)['id']);
});

test('Money::toPaisa uses string math and rejects floats', function () {
    same(123450, Money::toPaisa('1,234.50'));
    same(123450, Money::toPaisa('1234.5'));
    same(10000000, Money::toPaisa('1,00,000'));
    same(50, Money::toPaisa('0.50'));
    same(0, Money::toPaisa('0'));
    same(2500, Money::toPaisa(25));
    same(1999, Money::toPaisa('19.99'));
    foreach (array('1.234', '-5', 'abc', '', '1.2.3') as $bad) {
        throws('InvalidArgumentException', function () use ($bad) {
            Money::toPaisa($bad);
        });
    }
    throws('InvalidArgumentException', function () {
        Money::toPaisa(19.99);
    });
});

test('Money::formatNpr', function () {
    same('NPR 1,234.50', Money::formatNpr(123450));
    same('NPR 0.05', Money::formatNpr(5));
    same('NPR 1,234,567.00', Money::formatNpr(123456700));
    same('-NPR 1.00', Money::formatNpr(-100));
});

if (getenv('PAYMENTSNP_E2E_BASE_URL') && getenv('PAYMENTSNP_E2E_API_KEY')) {
    require __DIR__ . '/e2e.php';
}

$failed = 0;
foreach ($tests as $test) {
    try {
        $test[1]();
        echo "ok   - {$test[0]}\n";
    } catch (Throwable $error) {
        $failed++;
        echo "FAIL - {$test[0]}: {$error->getMessage()}\n";
    }
}
echo count($tests) - $failed . '/' . count($tests) . " passed (PHP " . PHP_VERSION . ")\n";
exit($failed ? 1 : 0);
