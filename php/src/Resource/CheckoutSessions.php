<?php

namespace Paymentsnp\Resource;

use Paymentsnp\PaymentsnpClient;

/** Checkout sessions. Scopes: checkout:create (create, expire), checkout:read (retrieve). */
class CheckoutSessions extends Resource
{
    /**
     * POST /checkout/sessions. Params: order_id, amount_minor (integer paisa),
     * currency "NPR", description, customer, allowed_methods, success_url,
     * cancel_url, metadata. Option idempotency_key: generated when omitted and
     * reused on this call's retries. Pass your own (e.g. from your order id)
     * to make retries across requests or processes safe.
     */
    public function create(array $params, array $options = array())
    {
        if (!isset($options['idempotency_key'])) {
            $options['idempotency_key'] = PaymentsnpClient::uuid();
        }
        return $this->client->request('POST', '/checkout/sessions', $params, $options);
    }

    /** GET /checkout/sessions/:id */
    public function retrieve($id)
    {
        return $this->client->request('GET', '/checkout/sessions/' . self::id($id));
    }

    /** POST /checkout/sessions/:id/expire */
    public function expire($id)
    {
        return $this->client->request('POST', '/checkout/sessions/' . self::id($id) . '/expire');
    }
}
