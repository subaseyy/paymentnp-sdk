// NPR amounts are integer paisa (1 rupee = 100 paisa). String math only.

/**
 * Converts a rupee amount to integer paisa: "1,234.50" -> 123450, 15 -> 1500.
 * Accepts digits with optional thousands/lakh commas and at most 2 decimals.
 * Throws on negatives, more than 2 decimals, or anything else.
 */
export function toPaisa(rupees: string | number): number {
  const text =
    typeof rupees === "number"
      ? Number.isFinite(rupees)
        ? String(rupees)
        : ""
      : rupees.trim();
  const match = /^(\d{1,3}(?:,\d{2,3})*|\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) throw new RangeError(`Invalid NPR amount: ${JSON.stringify(rupees)}`);
  const whole = match[1].replace(/,/g, "");
  const paisa = BigInt(whole) * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
  if (paisa > BigInt(Number.MAX_SAFE_INTEGER))
    throw new RangeError(`NPR amount too large: ${JSON.stringify(rupees)}`);
  return Number(paisa);
}

/** Formats integer paisa as "NPR 1,234.50", matching the dashboard and the PHP/Python SDKs. */
export function formatNpr(paisa: number | bigint): string {
  let value = BigInt(paisa);
  const negative = value < 0n;
  if (negative) value = -value;
  const whole = (value / 100n).toString();
  const fraction = (value % 100n).toString().padStart(2, "0");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}NPR ${grouped}.${fraction}`;
}
