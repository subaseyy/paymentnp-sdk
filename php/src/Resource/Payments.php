<?php

namespace Paymentsnp\Resource;

/** Verified payments. Scope: payments:read. */
class Payments extends Resource
{
    /** GET /payments. Params: limit, offset, provider, search, from, to (Nepal dates, both or neither). */
    public function list(array $params = array())
    {
        return $this->client->request('GET', '/payments', $params);
    }

    /** GET /payments/:id */
    public function retrieve($id)
    {
        return $this->client->request('GET', '/payments/' . self::id($id));
    }

    /** GET /payments/summary. Verified totals; never a balance. */
    public function summary(array $params = array())
    {
        return $this->client->request('GET', '/payments/summary', $params);
    }
}
