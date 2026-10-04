<?php

namespace Paymentsnp;

/**
 * Base class for every SDK error. API errors carry the response's
 * `{error: {code, message, request_id}}` fields.
 */
class PaymentsnpError extends \Exception
{
    /** @var int|null */
    public $status;
    /** @var string|null */
    public $errorCode;
    /** @var string|null */
    public $requestId;
    /** @var int|null Seconds from the Retry-After header, when sent. */
    public $retryAfter;

    public function __construct($message, $status = null, $code = null, $requestId = null, $retryAfter = null, $previous = null)
    {
        parent::__construct((string) $message, 0, $previous);
        $this->status = $status;
        $this->errorCode = $code;
        $this->requestId = $requestId;
        $this->retryAfter = $retryAfter;
    }

    public function getStatus()
    {
        return $this->status;
    }

    /** The API's snake_case error code, e.g. `insufficient_scope`. */
    public function getErrorCode()
    {
        return $this->errorCode;
    }

    public function getRequestId()
    {
        return $this->requestId;
    }

    public function getRetryAfter()
    {
        return $this->retryAfter;
    }

    /** Builds the right subclass for an HTTP error response. */
    public static function fromResponse($status, $body, array $headers)
    {
        $error = is_array($body) && isset($body['error']) && is_array($body['error']) ? $body['error'] : array();
        $code = isset($error['code']) ? (string) $error['code'] : null;
        $message = isset($error['message']) ? (string) $error['message'] : 'Paymentsnp API returned HTTP ' . $status . '.';
        $requestId = isset($error['request_id']) ? (string) $error['request_id'] : (isset($headers['x-request-id']) ? $headers['x-request-id'] : null);
        $retryAfter = isset($headers['retry-after']) && is_numeric($headers['retry-after']) ? (int) $headers['retry-after'] : null;
        if ($status === 401) {
            $class = AuthenticationError::class;
        } elseif ($status === 403) {
            $class = PermissionError::class;
        } elseif ($status === 429) {
            $class = RateLimitError::class;
        } elseif ($status >= 500) {
            $class = ApiError::class;
        } elseif ($status >= 400) {
            $class = InvalidRequestError::class;
        } else {
            $class = PaymentsnpError::class;
        }
        return new $class($message, $status, $code, $requestId, $retryAfter);
    }
}
