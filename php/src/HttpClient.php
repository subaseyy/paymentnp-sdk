<?php

namespace Paymentsnp;

/**
 * Transport used by PaymentsnpClient. Swap it (option `http_client`) to use
 * your own HTTP stack or a stub in tests.
 */
interface HttpClient
{
    /**
     * @param string        $method  GET, POST or PATCH
     * @param string        $url     Absolute URL
     * @param string[]      $headers "Name: value" lines
     * @param string|null   $body    Raw request body
     * @param int|float     $timeout Seconds
     * @return array{0:int,1:array<string,string>,2:string} [status, lower-cased headers, body]
     * @throws ConnectionError when no HTTP response was received
     */
    public function request($method, $url, array $headers, $body, $timeout);
}
