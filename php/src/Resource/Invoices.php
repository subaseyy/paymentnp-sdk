<?php

namespace Paymentsnp\Resource;

/** Invoices. Scopes: invoices:read (list, retrieve, pdf), invoices:write (the rest). */
class Invoices extends Resource
{
    /** GET /invoices. Params: status, search, limit, offset. */
    public function list(array $params = array())
    {
        return $this->client->request('GET', '/invoices', $params);
    }

    /** GET /invoices/:id */
    public function retrieve($id)
    {
        return $this->client->request('GET', '/invoices/' . self::id($id));
    }

    /** POST /invoices: a draft. Params: customer_id or customer, line_items, vat_enabled, discount, days_until_due, due_date, memo, footer. */
    public function create(array $params)
    {
        return $this->client->request('POST', '/invoices', $params);
    }

    /** PATCH /invoices/:id (drafts only). Same params as create. */
    public function update($id, array $params)
    {
        return $this->client->request('PATCH', '/invoices/' . self::id($id), $params);
    }

    /** POST /invoices/:id/finalize */
    public function finalize($id)
    {
        return $this->client->request('POST', '/invoices/' . self::id($id) . '/finalize');
    }

    /** POST /invoices/:id/send. Params: channels (["email"], ["sms"] or both; default email). */
    public function send($id, array $params = array())
    {
        return $this->client->request('POST', '/invoices/' . self::id($id) . '/send', $params);
    }

    /** POST /invoices/:id/mark-paid. Params: note (3-500 characters). */
    public function markPaid($id, array $params)
    {
        return $this->client->request('POST', '/invoices/' . self::id($id) . '/mark-paid', $params);
    }

    /** POST /invoices/:id/void */
    public function void($id)
    {
        return $this->client->request('POST', '/invoices/' . self::id($id) . '/void');
    }

    /** POST /invoices/:id/uncollectible */
    public function markUncollectible($id)
    {
        return $this->client->request('POST', '/invoices/' . self::id($id) . '/uncollectible');
    }

    /** POST /invoices/:id/duplicate: a new draft copy. */
    public function duplicate($id)
    {
        return $this->client->request('POST', '/invoices/' . self::id($id) . '/duplicate');
    }

    /** GET /invoices/:id/pdf. Returns the PDF bytes as a string. */
    public function pdf($id)
    {
        return $this->client->request('GET', '/invoices/' . self::id($id) . '/pdf', null, array(), true);
    }
}
