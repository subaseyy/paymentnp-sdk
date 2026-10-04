"""TypedDicts for the main request and response shapes (snake_case, as the API sends them).

Responses are plain dicts at runtime; these types are for editors and type checkers.
"""

from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional, TypedDict

Provider = Literal["esewa", "khalti", "fonepay", "nepalpay_qr", "sandbox"]
Environment = Literal["test", "live"]


class Customer(TypedDict, total=False):
    external_id: str
    name: str
    email: str
    phone: str


class _CheckoutSessionCreateRequired(TypedDict):
    order_id: str
    amount_minor: int
    currency: Literal["NPR"]


class CheckoutSessionCreateParams(_CheckoutSessionCreateRequired, total=False):
    description: str
    customer: Customer
    allowed_methods: List[Provider]
    success_url: str
    cancel_url: str
    metadata: Dict[str, str]


class _CheckoutSessionBase(TypedDict):
    id: str
    order_id: str
    status: Literal["open", "processing", "paid", "expired"]
    amount_minor: int
    currency: str
    environment: Environment
    available_methods: List[Provider]
    expires_at: str


class CheckoutSession(_CheckoutSessionBase, total=False):
    # Only on create.
    checkout_url: str
    public_session_path: str


class Payment(TypedDict):
    id: str
    order_id: str
    customer_id: Optional[str]
    customer: Optional[Dict[str, Any]]
    environment: Environment
    provider: Provider
    provider_transaction_id: str
    amount_minor: int
    currency: str
    verified_at: str
    is_simulated: bool


class PaymentList(TypedDict):
    data: List[Payment]
    limit: int
    offset: int
    environment: Environment
    has_more: bool


class WebhookEvent(TypedDict):
    id: str
    type: str  # payment.succeeded, payment.failed, checkout.expired, webhook.test
    api_version: str
    environment: Environment
    created_at: str
    data: Dict[str, Any]
