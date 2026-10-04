<?php

// For projects without Composer (e.g. WHMCS modules):
//   require_once '/path/to/paymentsnp-php/init.php';

$paymentsnpFiles = array(
    'PaymentsnpError', 'AuthenticationError', 'PermissionError', 'InvalidRequestError',
    'RateLimitError', 'ApiError', 'ConnectionError', 'SignatureVerificationError',
    'HttpClient', 'CurlHttpClient', 'Money', 'Webhook',
    'Resource/Resource', 'Resource/CheckoutSessions', 'Resource/Checkout',
    'Resource/Payments', 'Resource/Invoices', 'Resource/Reconciliation',
    'PaymentsnpClient',
);
foreach ($paymentsnpFiles as $paymentsnpFile) {
    require_once __DIR__ . '/src/' . $paymentsnpFile . '.php';
}
unset($paymentsnpFiles, $paymentsnpFile);
