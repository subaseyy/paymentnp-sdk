<?php

namespace Paymentsnp\Resource;

use Paymentsnp\PaymentsnpClient;

abstract class Resource
{
    /** @var PaymentsnpClient */
    protected $client;

    public function __construct(PaymentsnpClient $client)
    {
        $this->client = $client;
    }

    protected static function id($id)
    {
        if (!is_string($id) || $id === '') {
            throw new \InvalidArgumentException('An id is required.');
        }
        return rawurlencode($id);
    }
}
