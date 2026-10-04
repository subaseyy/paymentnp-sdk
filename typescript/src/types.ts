// Request and response shapes, typed from the API source (backend/src).
// Field names are the API's snake_case names, unchanged. Amounts are integer
// paisa (`*_minor`), currency is always "NPR". Timestamps are ISO strings.

export type Environment = "test" | "live";
export type Provider = "esewa" | "khalti" | "fonepay" | "nepalpay_qr" | "sandbox";

export interface CustomerInput {
  external_id?: string;
  name?: string;
  email?: string;
  /** Nepal mobile, e.g. "98XXXXXXXX" or "+97798XXXXXXXX". */
  phone?: string;
}

// ---- Checkout sessions ----------------------------------------------------

export interface CheckoutSessionCreateParams {
  /** Your order reference (1-120 chars). Amount/currency/customer are immutable per order. */
  order_id: string;
  /** Integer paisa, 1..100000000000. Use toPaisa("1500.00"). */
  amount_minor: number;
  currency: "NPR";
  description?: string;
  /** Needs at least one of external_id, email or phone. */
  customer?: CustomerInput;
  allowed_methods?: Provider[];
  /** Must match one of the workspace's allowed return origins. */
  success_url?: string;
  cancel_url?: string;
  /** Up to 2000 chars of JSON; keys <= 50, values <= 200 chars. */
  metadata?: Record<string, string>;
}

export interface CheckoutSession {
  id: string;
  order_id: string;
  status: "open" | "processing" | "paid" | "expired" | "cancelled";
  amount_minor: number;
  currency: "NPR";
  environment: Environment;
  available_methods: Provider[];
  expires_at: string;
}

export interface CreatedCheckoutSession extends CheckoutSession {
  /** Send the customer here (hosted checkout, possibly on your custom domain). */
  checkout_url: string;
  public_session_path: string;
}

// ---- Payments -------------------------------------------------------------

export interface CustomerSnapshot {
  id?: string;
  external_id?: string | null;
  name?: string;
  email?: string | null;
  phone?: string | null;
}

export interface Payment {
  id: string;
  order_id: string;
  customer_id: string | null;
  customer: CustomerSnapshot | null;
  environment: Environment;
  provider: Provider;
  provider_transaction_id: string;
  amount_minor: number;
  currency: "NPR";
  verified_at: string;
  /** True for sandbox payments (test environment only). */
  is_simulated: boolean;
}

export interface PaymentListParams {
  limit?: number;
  offset?: number;
  /** Matches order id, transaction id, customer name/email/phone. */
  search?: string;
  provider?: Provider;
  /** Nepal calendar days (YYYY-MM-DD), inclusive; send both or neither. */
  from?: string;
  to?: string;
  /** Optional; an API key can only read its own environment. */
  environment?: Environment;
}

export interface PaymentList {
  data: Payment[];
  limit: number;
  offset: number;
  environment: Environment;
  has_more: boolean;
}

export interface PaymentSummary {
  environment: Environment;
  currency: "NPR";
  gross_payments_received_minor: number;
  successful_payment_count: number;
  pending_attempt_count: number;
  provider_fees_minor: null;
  settlement_status: "unknown";
  refunds_supported: false;
  /** Paymentsnp never holds funds; this is not a balance. */
  is_balance: false;
}

// ---- Invoices -------------------------------------------------------------

export type InvoiceStatus = "draft" | "open" | "paid" | "void" | "uncollectible";
export type InvoiceDiscount =
  | { type: "amount"; amount_minor: number }
  | { type: "percent"; percent: number };

export interface InvoiceLineItemInput {
  description: string;
  quantity: number;
  unit_amount_minor: number;
  /** Taxable when vat_enabled (default true). */
  vat?: boolean;
}

/** Create and update take the full draft (update replaces it). */
export interface InvoiceDraftParams {
  /** Exactly one of customer_id or customer. */
  customer_id?: string;
  customer?: CustomerInput;
  line_items: InvoiceLineItemInput[];
  vat_enabled?: boolean;
  discount?: InvoiceDiscount | null;
  days_until_due?: number;
  /** YYYY-MM-DD; overrides days_until_due. */
  due_date?: string | null;
  memo?: string;
  footer?: string;
}

export interface InvoiceLineItem {
  description: string;
  quantity: number;
  unit_amount_minor: number;
  vat: boolean;
  amount_minor: number;
  discount_minor: number;
  vat_minor: number;
}

export interface Invoice {
  id: string;
  invoice_number: string | null;
  status: InvoiceStatus;
  source: string;
  environment: Environment;
  overdue: boolean;
  merchant_name: string;
  seller: {
    legal_name: string | null;
    pan: string | null;
    registration_number: string | null;
    address: string | null;
  };
  order_id: string | null;
  amount_minor: number;
  subtotal_minor: number;
  discount_minor: number;
  vat_minor: number;
  total_minor: number;
  currency: "NPR";
  vat_enabled: boolean;
  discount: InvoiceDiscount | null;
  line_items: InvoiceLineItem[];
  days_until_due: number | null;
  due_date: string | null;
  memo: string;
  footer: string;
  customer: { name: string | null; email: string | null } | null;
  payment_method: Provider | null;
  provider_transaction_id: string | null;
  issued_at: string | null;
  paid_at: string | null;
  paid_outside: boolean;
  recipient_email: string | null;
  customer_phone: string | null;
  customer_id: string | null;
  paid_note: string | null;
  created_at: string;
  finalized_at: string | null;
  sent_at: string | null;
  viewed_at: string | null;
  voided_at: string | null;
  /** Hosted invoice page; null while draft. */
  public_url: string | null;
  timeline: { action: string; details: unknown; created_at: string }[];
}

export interface InvoiceListItem {
  id: string;
  invoice_number: string | null;
  status: InvoiceStatus;
  source: string;
  recipient_email: string | null;
  recipient_phone: string | null;
  customer_name: string | null;
  issued_at: string | null;
  paid_at: string | null;
  created_at: string;
  due_date: string | null;
  overdue: boolean;
  paid_outside: boolean;
  external_id: string | null;
  amount_minor: number;
  currency: "NPR";
}

export interface InvoiceListParams {
  status?: InvoiceStatus | "overdue";
  search?: string;
  /** 1..500, default 100. */
  limit?: number;
  offset?: number;
  environment?: Environment;
}

export interface InvoiceList {
  data: InvoiceListItem[];
  has_more: boolean;
  totals: {
    outstanding_minor: number;
    outstanding_count: number;
    overdue_minor: number;
    overdue_count: number;
    paid_minor: number;
    paid_count: number;
  };
}

export interface InvoiceSendParams {
  /** Default ["email"]. */
  channels?: ("email" | "sms")[];
}

// ---- Reconciliation -------------------------------------------------------

export type ReconciliationStatus = "matched" | "unmatched" | "mismatch" | "reviewed";

export interface SettlementRecordInput {
  provider: Provider;
  settlement_reference: string;
  provider_transaction_id: string;
  settled_amount_minor: number;
  /** ISO datetime with offset, e.g. "2026-10-01T10:00:00+05:45". */
  settled_at: string;
}

export interface ReconciliationRecord {
  id: string;
  environment: Environment;
  provider: Provider;
  settlement_reference: string;
  provider_transaction_id: string;
  payment_id: string | null;
  settled_amount_minor: number;
  settled_at: string;
  status: ReconciliationStatus;
  review_note?: string | null;
  reviewed_at?: string | null;
  created_at: string;
  payment_amount_minor?: number | null;
}

export interface ReconciliationListParams {
  limit?: number;
  offset?: number;
  environment?: Environment;
}

export interface ReconciliationList {
  data: ReconciliationRecord[];
  environment: Environment;
  limit: number;
  offset: number;
  has_more: boolean;
}

export interface ReconciliationBulkResult {
  environment: Environment;
  counts: Record<string, number>;
  results: {
    index: number;
    status: ReconciliationStatus | "duplicate" | "invalid";
    id?: string;
    settlement_reference?: string;
    error?: string;
  }[];
}

export interface ReconciliationReportParams {
  period?: 7 | 30 | 90 | "7" | "30" | "90";
  environment?: Environment;
}

export interface ReconciliationReport {
  environment: Environment;
  period_days: number;
  currency: "NPR";
  totals: {
    verified_count: number;
    verified_gross_minor: number;
    settled_count: number;
    settled_minor: number;
    difference_minor: number;
    provider_fees_minor: null;
  };
  summary: { status: ReconciliationStatus; count: number; amount_minor: number }[];
  providers: {
    provider: Provider;
    verified_count: number;
    verified_gross_minor: number;
    settled_count: number;
    settled_minor: number;
    difference_minor: number;
    provider_fees_minor: null;
  }[];
}

// ---- Webhooks -------------------------------------------------------------

interface EventBase<T extends string, D> {
  id: string;
  type: T;
  api_version: "v1";
  environment: Environment;
  created_at: string;
  data: D;
}

export type PaymentSucceededEvent = EventBase<
  "payment.succeeded",
  {
    payment_id: string;
    checkout_session_id: string;
    order_id: string;
    provider: Provider;
    provider_transaction_id: string;
    amount_minor: number;
    currency: "NPR";
    is_simulated: boolean;
    /** True when the order was already paid (a second success). */
    overpaid?: boolean;
    status?: "succeeded";
  }
>;
export type PaymentFailedEvent = EventBase<
  "payment.failed",
  {
    attempt_id: string;
    checkout_session_id: string;
    order_id: string;
    provider?: Provider;
    reason?: string;
    is_simulated: boolean;
  }
>;
export type CheckoutExpiredEvent = EventBase<
  "checkout.expired",
  { checkout_session_id: string; order_id: string }
>;
export type WebhookTestEvent = EventBase<
  "webhook.test",
  { endpoint_id: string; message: string }
>;
export type WebhookEvent =
  | PaymentSucceededEvent
  | PaymentFailedEvent
  | CheckoutExpiredEvent
  | WebhookTestEvent;
