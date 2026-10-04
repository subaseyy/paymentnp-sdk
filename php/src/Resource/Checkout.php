<?php

namespace Paymentsnp\Resource;

use Paymentsnp\PaymentsnpClient;

class Checkout
{
    /** @var CheckoutSessions */
    public $sessions;

    public function __construct(PaymentsnpClient $client)
    {
        $this->sessions = new CheckoutSessions($client);
    }
}
