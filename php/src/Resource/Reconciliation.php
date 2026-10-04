<?php

namespace Paymentsnp\Resource;

/** Settlement records. Scopes: reconciliation:read, reconciliation:write. */
class Reconciliation extends Resource
{
    /** GET /reconciliation. Params: limit, offset. */
    public function list(array $params = array())
    {
        return $this->client->request('GET', '/reconciliation', $params);
    }

    /** GET /reconciliation/report. Params: period "7", "30" or "90". */
    public function report(array $params = array())
    {
        return $this->client->request('GET', '/reconciliation/report', $params);
    }

    /**
     * POST /reconciliation/import. Params: provider, settlement_reference,
     * provider_transaction_id, settled_amount_minor, settled_at. A duplicate
     * settlement_reference raises InvalidRequestError (409 duplicate_settlement).
     */
    public function importSettlement(array $params)
    {
        return $this->client->request('POST', '/reconciliation/import', $params);
    }

    /** POST /reconciliation/import/bulk. Params: records (1-500 rows); returns per-row results. */
    public function importBulk(array $params)
    {
        return $this->client->request('POST', '/reconciliation/import/bulk', $params);
    }
}
