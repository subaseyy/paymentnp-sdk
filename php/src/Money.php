<?php

namespace Paymentsnp;

/** NPR helpers. The API takes amounts as integer paisa (1 rupee = 100 paisa). */
class Money
{
    /**
     * Rupees to paisa without float math: "1,234.50" -> 123450, 25 -> 2500.
     * Accepts an int or a numeric string with up to 2 decimals; floats are
     * rejected because they cannot hold money exactly.
     */
    public static function toPaisa($rupees)
    {
        if (is_int($rupees)) {
            if ($rupees < 0) {
                throw new \InvalidArgumentException('Amount must not be negative.');
            }
            return $rupees * 100;
        }
        if (!is_string($rupees)) {
            throw new \InvalidArgumentException('Pass the amount as a string or int, not a float.');
        }
        $value = str_replace(array(',', ' '), '', trim($rupees));
        if (!preg_match('/^(\d+)(?:\.(\d{1,2}))?$/', $value, $match)) {
            throw new \InvalidArgumentException('Invalid NPR amount: use digits with at most 2 decimals.');
        }
        $fraction = isset($match[2]) ? str_pad($match[2], 2, '0') : '00';
        return (int) (ltrim($match[1], '0') . $fraction);
    }

    /** Paisa to display text: 123450 -> "NPR 1,234.50". */
    public static function formatNpr($paisa)
    {
        if (!is_int($paisa)) {
            throw new \InvalidArgumentException('Amount must be integer paisa.');
        }
        $abs = abs($paisa);
        return ($paisa < 0 ? '-' : '') . 'NPR ' . number_format(intdiv($abs, 100)) . '.' . sprintf('%02d', $abs % 100);
    }
}
