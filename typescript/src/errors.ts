// Every API error body is { error: { code, message, request_id } }.
export class PaymentsnpError extends Error {
  /** HTTP status; 0 when no response was received. */
  readonly status: number;
  /** Machine-readable code from the API, e.g. "insufficient_scope". */
  readonly code: string;
  /** X-Request-Id of the failed request, when the API answered. */
  readonly requestId: string | null;
  /** Seconds from the Retry-After header (429 responses). */
  readonly retryAfter?: number;
  constructor(
    message: string,
    init: {
      status?: number;
      code?: string;
      requestId?: string | null;
      retryAfter?: number;
    } = {},
  ) {
    super(message);
    this.name = new.target.name;
    this.status = init.status ?? 0;
    this.code = init.code ?? "error";
    this.requestId = init.requestId ?? null;
    if (init.retryAfter !== undefined) this.retryAfter = init.retryAfter;
  }
}
/** 401: missing, invalid, revoked or expired (`api_key_expired`) API key. */
export class AuthenticationError extends PaymentsnpError {}
/** 403: `insufficient_scope`, `api_key_ip_denied`, `environment_mismatch`, ... */
export class PermissionError extends PaymentsnpError {}
/** 400 / 404 / 409 / 422: invalid input, not found, conflicts. */
export class InvalidRequestError extends PaymentsnpError {}
/** 429: `rate_limited`; `retryAfter` holds the server's hint in seconds. */
export class RateLimitError extends PaymentsnpError {}
/** 5xx from the API. */
export class ApiError extends PaymentsnpError {}
/** Network failure or timeout (`code` is "connection_error" or "timeout"). */
export class ConnectionError extends PaymentsnpError {}
/** Webhook signature missing, malformed, wrong or outside the tolerance. */
export class SignatureVerificationError extends PaymentsnpError {}

export function errorFor(
  status: number,
  body: unknown,
  requestId: string | null,
  retryAfter?: number,
): PaymentsnpError {
  const error = (body as { error?: { code?: unknown; message?: unknown; request_id?: unknown } } | null)?.error;
  const code = typeof error?.code === "string" ? error.code : `http_${status}`;
  const message =
    typeof error?.message === "string"
      ? error.message
      : `Request failed with HTTP ${status}.`;
  const init = {
    status,
    code,
    requestId: typeof error?.request_id === "string" ? error.request_id : requestId,
    retryAfter,
  };
  if (status === 401) return new AuthenticationError(message, init);
  if (status === 403) return new PermissionError(message, init);
  if (status === 429) return new RateLimitError(message, init);
  if (status >= 500) return new ApiError(message, init);
  if ([400, 404, 409, 422].includes(status))
    return new InvalidRequestError(message, init);
  return new PaymentsnpError(message, init);
}
