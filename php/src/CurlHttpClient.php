<?php

namespace Paymentsnp;

/** Default transport: ext-curl, TLS verified, redirects not followed. */
class CurlHttpClient implements HttpClient
{
    public function request($method, $url, array $headers, $body, $timeout)
    {
        if (!function_exists('curl_init')) {
            throw new ConnectionError('The PHP cURL extension is required.');
        }
        $responseHeaders = array();
        $options = array(
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_CONNECTTIMEOUT => min(10, $timeout),
            CURLOPT_TIMEOUT => $timeout,
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_HEADERFUNCTION => function ($handle, $line) use (&$responseHeaders) {
                $parts = explode(':', $line, 2);
                if (count($parts) === 2) {
                    $responseHeaders[strtolower(trim($parts[0]))] = trim($parts[1]);
                }
                return strlen($line);
            },
        );
        if ($body !== null) {
            $options[CURLOPT_POSTFIELDS] = $body;
        }
        $handle = curl_init($url);
        curl_setopt_array($handle, $options);
        $raw = curl_exec($handle);
        $error = curl_error($handle);
        $status = (int) curl_getinfo($handle, CURLINFO_HTTP_CODE);
        curl_close($handle);
        if ($raw === false) {
            throw new ConnectionError('Could not reach the Paymentsnp API at ' . parse_url($url, PHP_URL_HOST) . ': ' . $error);
        }
        return array($status, $responseHeaders, (string) $raw);
    }
}
