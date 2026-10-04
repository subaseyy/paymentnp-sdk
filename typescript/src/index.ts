import { ConnectionError, PaymentsnpError, errorFor } from "./errors.js";
import type * as T from "./types.js";
import { webCrypto, webhooks } from "./webhooks.js";

export * from "./errors.js";
export * from "./types.js";
export { toPaisa, formatNpr } from "./money.js";
export {
  webhooks,
  constructEvent,
  verifySignature,
  generateTestHeader,
  SIGNATURE_HEADER,
  EVENT_ID_HEADER,
  type VerifyOptions,
} from "./webhooks.js";

export const VERSION = "1.0.0";
export const DEFAULT_BASE_URL = "https://api.paymentnp.com/v1";

export interface PaymentsnpOptions {
  /** Secret API key, np_test_... or np_live_... Server-side only. */
  apiKey: string;
  /** Default https://api.paymentnp.com/v1 */
  baseUrl?: string;
  /** Per-attempt timeout. Default 30000. */
  timeoutMs?: number;
  /** Automatic retries for retryable failures. Default 2. */
  maxRetries?: number;
  /** Custom fetch implementation (defaults to the global fetch). */
  fetch?: typeof fetch;
  /** Override the backoff sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
}

export interface RequestOptions {
  /**
   * Checkout create: replaces the auto-generated key (reuse the same key to
   * safely repeat the same request). Other POSTs: opts into retrying
   * connection failures; the API does not deduplicate those requests.
   */
  idempotencyKey?: string;
}

type Query = Record<string, string | number | undefined>;
// safe: retry network errors, 429 and 5xx. connection: network errors only
// (no timeouts, since the request may have been processed). none: no retry.
export type Retry = "safe" | "connection" | "none";
export interface RawRequest {
  query?: Query;
  body?: unknown;
  idempotencyKey?: string;
  retry: Retry;
  binary?: boolean;
}

const id = (value: string) => encodeURIComponent(value);
const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function retryAfterSeconds(header: string | null) {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, (date - Date.now()) / 1000);
}

export class Paymentsnp {
  /** Webhook helpers; also exported as `webhooks`. No API key needed. */
  static webhooks = webhooks;
  readonly environment: T.Environment;
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  #apiKey: string;
  #fetch: typeof fetch;
  #sleep: (ms: number) => Promise<void>;

  constructor(options: PaymentsnpOptions) {
    const match = /^np_(test|live)_/.exec(options?.apiKey ?? "");
    if (!match)
      throw new PaymentsnpError(
        "apiKey must be a Paymentsnp secret key starting with np_test_ or np_live_.",
        { code: "invalid_api_key" },
      );
    this.#apiKey = options.apiKey;
    this.environment = match[1] as T.Environment;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 30000;
    this.maxRetries = Math.max(0, options.maxRetries ?? 2);
    const f = options.fetch ?? globalThis.fetch;
    if (!f) throw new PaymentsnpError("No fetch implementation available.");
    this.#fetch = f.bind(globalThis);
    this.#sleep = options.sleep ?? defaultSleep;
  }

  /** Never expose the key when the client is logged or serialised. */
  toJSON() {
    return { environment: this.environment, baseUrl: this.baseUrl };
  }

  readonly checkout = {
    sessions: {
      /** POST /checkout/sessions (scope checkout:create). Always idempotent. */
      create: async (
        params: T.CheckoutSessionCreateParams,
        options: RequestOptions = {},
      ): Promise<T.CreatedCheckoutSession> =>
        this.request("POST", "/checkout/sessions", {
          body: params,
          idempotencyKey:
            options.idempotencyKey ?? (await webCrypto()).randomUUID(),
          retry: "safe",
        }),
      /** GET /checkout/sessions/:id (scope checkout:read). */
      retrieve: (sessionId: string): Promise<T.CheckoutSession> =>
        this.request("GET", `/checkout/sessions/${id(sessionId)}`, { retry: "safe" }),
      /** POST /checkout/sessions/:id/expire (scope checkout:create). Safe to repeat. */
      expire: (sessionId: string): Promise<T.CheckoutSession> =>
        this.request("POST", `/checkout/sessions/${id(sessionId)}/expire`, {
          retry: "safe",
        }),
    },
  };

  readonly payments = {
    /** GET /payments (scope payments:read). Verified payments only. */
    list: (params: T.PaymentListParams = {}): Promise<T.PaymentList> =>
      this.request("GET", "/payments", { query: { ...params }, retry: "safe" }),
    /** GET /payments/:id (scope payments:read). */
    retrieve: (paymentId: string): Promise<T.Payment> =>
      this.request("GET", `/payments/${id(paymentId)}`, { retry: "safe" }),
    /** GET /payments/summary (scope payments:read). Not a balance. */
    summary: (params: { environment?: T.Environment } = {}): Promise<T.PaymentSummary> =>
      this.request("GET", "/payments/summary", { query: { ...params }, retry: "safe" }),
  };

  readonly invoices = {
    /** GET /invoices (scope invoices:read). */
    list: (params: T.InvoiceListParams = {}): Promise<T.InvoiceList> =>
      this.request("GET", "/invoices", { query: { ...params }, retry: "safe" }),
    /** GET /invoices/:id (scope invoices:read). */
    retrieve: (invoiceId: string): Promise<T.Invoice> =>
      this.request("GET", `/invoices/${id(invoiceId)}`, { retry: "safe" }),
    /** POST /invoices (scope invoices:write). Creates a draft. */
    create: (params: T.InvoiceDraftParams, options: RequestOptions = {}): Promise<T.Invoice> =>
      this.write("POST", "/invoices", params, options),
    /** PATCH /invoices/:id (scope invoices:write). Replaces a draft. */
    update: (
      invoiceId: string,
      params: T.InvoiceDraftParams,
      options: RequestOptions = {},
    ): Promise<T.Invoice> =>
      this.write("PATCH", `/invoices/${id(invoiceId)}`, params, options),
    /** POST /invoices/:id/finalize (scope invoices:write). Draft -> open, numbered. */
    finalize: (invoiceId: string, options: RequestOptions = {}): Promise<T.Invoice> =>
      this.write("POST", `/invoices/${id(invoiceId)}/finalize`, undefined, options),
    /** POST /invoices/:id/send (scope invoices:write). Emails and/or texts the link. */
    send: (
      invoiceId: string,
      params: T.InvoiceSendParams = {},
      options: RequestOptions = {},
    ): Promise<{ sent: true; channels: ("email" | "sms")[] }> =>
      this.write("POST", `/invoices/${id(invoiceId)}/send`, params, options),
    /** POST /invoices/:id/mark-paid (scope invoices:write). Paid outside Paymentsnp. */
    markPaid: (
      invoiceId: string,
      params: { note: string },
      options: RequestOptions = {},
    ): Promise<T.Invoice> =>
      this.write("POST", `/invoices/${id(invoiceId)}/mark-paid`, params, options),
    /** POST /invoices/:id/void (scope invoices:write). */
    void: (invoiceId: string, options: RequestOptions = {}): Promise<T.Invoice> =>
      this.write("POST", `/invoices/${id(invoiceId)}/void`, undefined, options),
    /** POST /invoices/:id/uncollectible (scope invoices:write). */
    markUncollectible: (invoiceId: string, options: RequestOptions = {}): Promise<T.Invoice> =>
      this.write("POST", `/invoices/${id(invoiceId)}/uncollectible`, undefined, options),
    /** POST /invoices/:id/duplicate (scope invoices:write). New draft. */
    duplicate: (invoiceId: string, options: RequestOptions = {}): Promise<T.Invoice> =>
      this.write("POST", `/invoices/${id(invoiceId)}/duplicate`, undefined, options),
    /** GET /invoices/:id/pdf (scope invoices:read). PDF bytes. */
    pdf: (invoiceId: string): Promise<Uint8Array> =>
      this.request("GET", `/invoices/${id(invoiceId)}/pdf`, {
        retry: "safe",
        binary: true,
      }),
  };

  readonly reconciliation = {
    /** GET /reconciliation (scope reconciliation:read). */
    list: (params: T.ReconciliationListParams = {}): Promise<T.ReconciliationList> =>
      this.request("GET", "/reconciliation", { query: { ...params }, retry: "safe" }),
    /** GET /reconciliation/report (scope reconciliation:read). */
    report: (params: T.ReconciliationReportParams = {}): Promise<T.ReconciliationReport> =>
      this.request("GET", "/reconciliation/report", { query: { ...params }, retry: "safe" }),
    /**
     * POST /reconciliation/import (scope reconciliation:write). A reference
     * that already exists returns 409 duplicate_settlement.
     */
    import: (
      record: T.SettlementRecordInput,
      options: RequestOptions = {},
    ): Promise<T.ReconciliationRecord> =>
      this.write("POST", "/reconciliation/import", record, options),
    /**
     * POST /reconciliation/import/bulk (scope reconciliation:write). Up to 500
     * rows, per-row results; existing references come back as "duplicate".
     */
    importBulk: (
      params: { records: T.SettlementRecordInput[] },
      options: RequestOptions = {},
    ): Promise<T.ReconciliationBulkResult> =>
      this.write("POST", "/reconciliation/import/bulk", params, options),
  };

  private write<R>(
    method: string,
    path: string,
    body: unknown,
    options: RequestOptions,
  ): Promise<R> {
    return this.request(method, path, {
      body,
      idempotencyKey: options.idempotencyKey,
      retry: options.idempotencyKey ? "connection" : "none",
    });
  }

  /**
   * Low-level call relative to baseUrl, e.g. request("GET", "/payments").
   * Prefer the resource methods.
   */
  async request<R>(method: string, path: string, call: RawRequest): Promise<R> {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(call.query ?? {}))
      if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#apiKey}`,
      Accept: call.binary ? "application/pdf" : "application/json",
      "User-Agent": `paymentsnp-node/${VERSION}`,
    };
    if (call.body !== undefined) headers["Content-Type"] = "application/json";
    if (call.idempotencyKey) headers["Idempotency-Key"] = call.idempotencyKey;
    const body = call.body === undefined ? undefined : JSON.stringify(call.body);

    for (let attempt = 0; ; attempt++) {
      const canRetry = attempt < this.maxRetries;
      let response: Response;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        response = await this.#fetch(url, {
          method,
          headers,
          body,
          signal: controller.signal,
          redirect: "error",
        });
      } catch (cause) {
        clearTimeout(timer);
        const timedOut = controller.signal.aborted;
        const error = new ConnectionError(
          timedOut
            ? `Request timed out after ${this.timeoutMs} ms.`
            : `Could not reach Paymentsnp: ${cause instanceof Error ? cause.message : String(cause)}`,
          { code: timedOut ? "timeout" : "connection_error" },
        );
        if (
          canRetry &&
          (call.retry === "safe" || (call.retry === "connection" && !timedOut))
        ) {
          await this.#sleep(this.backoff(attempt));
          continue;
        }
        throw error;
      }
      try {
        const requestId = response.headers.get("x-request-id");
        if (response.ok) {
          if (call.binary) return new Uint8Array(await response.arrayBuffer()) as R;
          const text = await response.text();
          return (text ? JSON.parse(text) : undefined) as R;
        }
        const retryAfter = retryAfterSeconds(response.headers.get("retry-after"));
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(await response.text());
        } catch {
          // Non-JSON error body (proxy page); fall back to a generic message.
        }
        const error = errorFor(response.status, parsed, requestId, retryAfter);
        if (
          canRetry &&
          call.retry === "safe" &&
          (response.status === 429 || response.status >= 500)
        ) {
          await this.#sleep(
            response.status === 429 && retryAfter !== undefined
              ? Math.min(retryAfter, 60) * 1000
              : this.backoff(attempt),
          );
          continue;
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }
  }

  // 0.5s, 1s, 2s, ... capped at 8s, with 50-100% jitter.
  private backoff(attempt: number) {
    return Math.min(500 * 2 ** attempt, 8000) * (0.5 + Math.random() * 0.5);
  }
}

export default Paymentsnp;
