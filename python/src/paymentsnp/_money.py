from __future__ import annotations

import re
from decimal import Decimal
from typing import Union

_AMOUNT = re.compile(r"^(\d+)(?:\.(\d{1,2}))?$")


def to_paisa(rupees: Union[str, int, Decimal]) -> int:
    """Rupees to integer paisa without float math: ``"1,234.50"`` -> ``123450``.

    Accepts a string (commas allowed), an int or a Decimal with at most 2
    decimals. Floats are rejected because they cannot hold money exactly.
    """
    if isinstance(rupees, bool) or isinstance(rupees, float):
        raise TypeError("Pass the amount as a str, int or Decimal, not a float.")
    if isinstance(rupees, (int, Decimal)):
        rupees = str(rupees)
    if not isinstance(rupees, str):
        raise TypeError("Pass the amount as a str, int or Decimal.")
    match = _AMOUNT.match(rupees.strip().replace(",", "").replace(" ", ""))
    if not match:
        raise ValueError(f"Invalid NPR amount {rupees!r}: use digits with at most 2 decimals.")
    return int(match.group(1)) * 100 + int((match.group(2) or "0").ljust(2, "0"))


def format_npr(paisa: int) -> str:
    """Integer paisa to display text: ``123450`` -> ``"NPR 1,234.50"``."""
    if isinstance(paisa, bool) or not isinstance(paisa, int):
        raise TypeError("Amount must be integer paisa.")
    rupees, cents = divmod(abs(paisa), 100)
    return f"{'-' if paisa < 0 else ''}NPR {rupees:,}.{cents:02d}"
