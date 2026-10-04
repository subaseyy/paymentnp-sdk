<?php

namespace Paymentsnp;

/**
 * Webhook signature verification.
 *
 * Paymentsnp signs each delivery with
 *   Paymentnp-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
 * and sends the event id in Paymentnp-Event-Id (use it to de-duplicate).
 */
class Webhook
{
    const DEFAULT_TOLERANCE = 300;

    /**
     * Verifies the signature over the exact raw body and returns the decoded
     * event array ({id, type, api_version, environment, created_at, data}).
     *
     * @param string $rawBody         The unparsed request body (php://input)
     * @param string $signatureHeader The Paymentnp-Signature header
     * @param string $secret          The endpoint's whsec_ secret
     * @param int    $tolerance       Max age of the timestamp in seconds (0 disables)
     * @throws SignatureVerificationError
     */
    public static function constructEvent($rawBody, $signatureHeader, $secret, $tolerance = self::DEFAULT_TOLERANCE)
    {
        if (!is_string($rawBody) || !is_string($secret) || $secret === '') {
            throw new SignatureVerificationError('A raw string body and the webhook secret are required.');
        }
        $timestamp = null;
        $signatures = array();
        foreach (explode(',', (string) $signatureHeader) as $part) {
            $pair = explode('=', trim($part), 2);
            if (count($pair) !== 2) {
                continue;
            }
            if ($pair[0] === 't' && ctype_digit($pair[1])) {
                $timestamp = (int) $pair[1];
            } elseif ($pair[0] === 'v1') {
                $signatures[] = $pair[1];
            }
        }
        if ($timestamp === null || !$signatures) {
            throw new SignatureVerificationError('Missing or malformed Paymentnp-Signature header.');
        }
        $expected = hash_hmac('sha256', $timestamp . '.' . $rawBody, $secret);
        $matched = false;
        foreach ($signatures as $signature) {
            if (hash_equals($expected, $signature)) {
                $matched = true;
            }
        }
        if (!$matched) {
            throw new SignatureVerificationError('Webhook signature does not match the payload.');
        }
        if ($tolerance > 0 && abs(time() - $timestamp) > $tolerance) {
            throw new SignatureVerificationError('Webhook timestamp is outside the tolerance window.');
        }
        $event = json_decode($rawBody, true);
        if (!is_array($event)) {
            throw new SignatureVerificationError('Webhook body is not valid JSON.');
        }
        return $event;
    }

    /** Builds a Paymentnp-Signature header value, for testing your handler. */
    public static function generateTestHeader($body, $secret, $timestamp = null)
    {
        $timestamp = $timestamp === null ? time() : (int) $timestamp;
        return 't=' . $timestamp . ',v1=' . hash_hmac('sha256', $timestamp . '.' . $body, $secret);
    }
}
