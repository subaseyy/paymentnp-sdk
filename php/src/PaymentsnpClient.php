<?php

namespace Paymentsnp;

/**
 * Paymentsnp API client.
 *
 *   $client = new \Paymentsnp\PaymentsnpClient('np_test_...');
 *   $session = $client->checkout->sessions->create([...]);
 *
 * Options: base_url, timeout (seconds, default 30), max_retries (default 2),
 * http_client (an HttpClient implementation).
 */
class PaymentsnpClient
{
    const VERSION = '1.0.0';
    const DEFAULT_BASE_URL = 'https://api.paymentnp.com/v1';

    /** @var Resource\Checkout */
    public $checkout;
    /** @var Resource\Payments */
    public $payments;
    /** @var Resource\Invoices */
    public $invoices;
    /** @var Resource\Reconciliation */
    public $reconciliation;

    /** @var string "test" or "live", from the key prefix. */
    public $environment;

    private $apiKey;
    private $baseUrl;
    private $timeout;
    private $maxRetries;
    private $http;

    /**
     * @param string|array $apiKey The API key, or an options array with `api_key`.
     */
    public function __construct($apiKey, array $options = array())
    {
        if (is_array($apiKey)) {
            $options = $apiKey;
            $apiKey = isset($options['api_key']) ? $options['api_key'] : null;
        }
        if (!is_string($apiKey) || !preg_match('/^np_(test|live)_/', $apiKey, $match)) {
            throw new \InvalidArgumentException('api_key must be a Paymentsnp API key starting with np_test_ or np_live_.');
        }
        $this->apiKey = $apiKey;
        $this->environment = $match[1];
        $this->baseUrl = rtrim(isset($options['base_url']) ? $options['base_url'] : self::DEFAULT_BASE_URL, '/');
        $this->timeout = isset($options['timeout']) ? $options['timeout'] : 30;
        $this->maxRetries = isset($options['max_retries']) ? max(0, (int) $options['max_retries']) : 2;
        $this->http = isset($options['http_client']) ? $options['http_client'] : new CurlHttpClient();
        if (!$this->http instanceof HttpClient) {
            throw new \InvalidArgumentException('http_client must implement Paymentsnp\HttpClient.');
        }
        $this->checkout = new Resource\Checkout($this);
        $this->payments = new Resource\Payments($this);
        $this->invoices = new Resource\Invoices($this);
        $this->reconciliation = new Resource\Reconciliation($this);
    }

    /**
     * Sends one API request. GET params become the query string; POST/PATCH
     * params the JSON body. Returns the decoded JSON (or raw bytes when
     * $raw is true).
     *
     * Retries connection errors, 429 and 5xx with backoff, but only for GETs
     * and for POSTs that carry an Idempotency-Key (option `idempotency_key`).
     *
     * @return mixed
     */
    public function request($method, $path, $params = null, array $options = array(), $raw = false)
    {
        $method = strtoupper($method);
        $url = $this->baseUrl . $path;
        $body = null;
        $headers = array(
            'Authorization: Bearer ' . $this->apiKey,
            'Accept: ' . ($raw ? 'application/pdf' : 'application/json'),
            'User-Agent: paymentsnp-php/' . self::VERSION,
        );
        if ($method === 'GET') {
            if ($params) {
                $url .= '?' . http_build_query($params, '', '&', PHP_QUERY_RFC3986);
            }
        } else {
            // An empty array would encode as [], the API wants an object.
            $body = $params ? json_encode($params, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) : '{}';
            if ($body === false) {
                throw new \InvalidArgumentException('Request params could not be JSON-encoded.');
            }
            $headers[] = 'Content-Type: application/json';
        }
        if (isset($options['idempotency_key'])) {
            $headers[] = 'Idempotency-Key: ' . $options['idempotency_key'];
        }
        $retryable = $method === 'GET' || ($method === 'POST' && isset($options['idempotency_key']));

        for ($attempt = 0;; $attempt++) {
            $error = null;
            try {
                list($status, $responseHeaders, $responseBody) = $this->http->request($method, $url, $headers, $body, $this->timeout);
                if ($status >= 200 && $status < 300) {
                    if ($raw) {
                        return $responseBody;
                    }
                    return $responseBody === '' ? null : json_decode($responseBody, true);
                }
                $error = PaymentsnpError::fromResponse($status, json_decode($responseBody, true), $responseHeaders);
            } catch (ConnectionError $exception) {
                $error = $exception;
            }
            $transient = $error instanceof ConnectionError || $error instanceof RateLimitError || $error instanceof ApiError;
            if (!$retryable || !$transient || $attempt >= $this->maxRetries) {
                throw $error;
            }
            usleep((int) ($this->delay($attempt, $error->retryAfter) * 1000000));
        }
    }

    /** Seconds to wait before retry $attempt + 1: Retry-After (max 60s) or exponential backoff with jitter. */
    public function delay($attempt, $retryAfter = null)
    {
        if ($retryAfter !== null) {
            return min(60, max(0, $retryAfter));
        }
        $base = min(8, 0.5 * pow(2, $attempt));
        return $base / 2 + $base / 2 * mt_rand() / mt_getrandmax();
    }

    /** A random UUID v4, used as the default Idempotency-Key. */
    public static function uuid()
    {
        $bytes = random_bytes(16);
        $bytes[6] = chr(ord($bytes[6]) & 0x0f | 0x40);
        $bytes[8] = chr(ord($bytes[8]) & 0x3f | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($bytes), 4));
    }
}
