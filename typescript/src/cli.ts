// `paymentsnp` CLI. Zero dependencies: node:util parseArgs + the SDK.
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { Paymentsnp, PaymentsnpError, VERSION, formatNpr, toPaisa, webhooks } from "./index.js";

export interface CliIO {
  env: Record<string, string | undefined>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fetch?: typeof fetch;
  readFile?: (path: string) => Promise<Uint8Array>;
}

export const usage = `paymentsnp ${VERSION}

Usage:
  paymentsnp checkout create --amount 1500.00 --order ORD-1 [--success-url URL] [--cancel-url URL]
                             [--description TEXT] [--email E] [--phone P] [--idempotency-key K]
  paymentsnp checkout get <session_id>
  paymentsnp checkout expire <session_id>
  paymentsnp payments list [--limit N] [--offset N]
  paymentsnp payments get <payment_id>
  paymentsnp invoices list [--status S] [--limit N]
  paymentsnp webhooks verify --header '<Paymentnp-Signature>' --file body.json [--secret whsec_...]
  paymentsnp webhooks sign --file body.json [--secret whsec_...] [--timestamp UNIX]

Options:
  --json        Print raw JSON instead of a table.
  --base-url    API base URL (or PAYMENTSNP_BASE_URL). Default https://api.paymentnp.com/v1

Environment:
  PAYMENTSNP_API_KEY         np_test_... or np_live_... (required for API commands)
  PAYMENTSNP_WEBHOOK_SECRET  whsec_... (instead of --secret)
`;

const options = {
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean" },
  "api-key": { type: "string" },
  "base-url": { type: "string" },
  amount: { type: "string" },
  order: { type: "string" },
  "success-url": { type: "string" },
  "cancel-url": { type: "string" },
  description: { type: "string" },
  email: { type: "string" },
  phone: { type: "string" },
  "idempotency-key": { type: "string" },
  limit: { type: "string" },
  offset: { type: "string" },
  status: { type: "string" },
  secret: { type: "string" },
  header: { type: "string" },
  file: { type: "string" },
  timestamp: { type: "string" },
} as const;

export function parse(argv: string[]) {
  return parseArgs({ args: argv, options, allowPositionals: true, strict: true });
}

class UsageError extends Error {}

function cell(value: unknown) {
  if (value === null || value === undefined) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/** Plain-text table: amounts in *_minor columns are shown as NPR. */
export function table(rows: Record<string, unknown>[], columns: string[]) {
  const text = rows.map((row) =>
    columns.map((c) =>
      c.endsWith("_minor") && typeof row[c] === "number"
        ? formatNpr(row[c] as number)
        : cell(row[c]),
    ),
  );
  const widths = columns.map((c, i) =>
    Math.max(c.length, ...text.map((r) => r[i].length)),
  );
  const line = (cells: string[]) =>
    cells.map((v, i) => v.padEnd(widths[i])).join("  ").trimEnd();
  return [line(columns), ...text.map(line)].join("\n") + "\n";
}

function record(value: Record<string, unknown>) {
  const width = Math.max(...Object.keys(value).map((k) => k.length));
  return (
    Object.entries(value)
      .map(([k, v]) =>
        `${k.padEnd(width)}  ${
          k.endsWith("_minor") && typeof v === "number" ? formatNpr(v) : cell(v)
        }`,
      )
      .join("\n") + "\n"
  );
}

export async function run(argv: string[], io: CliIO): Promise<number> {
  let parsed;
  try {
    parsed = parse(argv);
  } catch (error) {
    io.stderr(`${(error as Error).message}\n\n${usage}`);
    return 2;
  }
  const { values: v, positionals } = parsed;
  if (v.version) {
    io.stdout(`${VERSION}\n`);
    return 0;
  }
  const [group, command, arg] = positionals;
  if (v.help || !group) {
    io.stdout(usage);
    return v.help ? 0 : 2;
  }
  const print = (value: unknown, columns?: string[]) => {
    if (v.json) io.stdout(JSON.stringify(value, null, 2) + "\n");
    else if (columns && Array.isArray((value as { data?: unknown }).data))
      io.stdout(table((value as { data: Record<string, unknown>[] }).data, columns));
    else io.stdout(record(value as Record<string, unknown>));
  };
  const need = (value: string | undefined, name: string) => {
    if (!value) throw new UsageError(`Missing ${name}.`);
    return value;
  };
  const read = async (path: string) =>
    (io.readFile ?? ((p: string) => readFile(p)))(path);
  const int = (value: string | undefined, name: string) => {
    if (value === undefined) return undefined;
    if (!/^\d+$/.test(value)) throw new UsageError(`${name} must be a whole number.`);
    return Number(value);
  };
  const secret = () =>
    need(v.secret ?? io.env.PAYMENTSNP_WEBHOOK_SECRET, "--secret or PAYMENTSNP_WEBHOOK_SECRET");
  const client = () => {
    if (v["api-key"])
      io.stderr(
        "Warning: --api-key ends up in your shell history. Use the PAYMENTSNP_API_KEY environment variable instead.\n",
      );
    const apiKey = v["api-key"] ?? io.env.PAYMENTSNP_API_KEY;
    if (!apiKey) throw new UsageError("Set PAYMENTSNP_API_KEY to your np_test_/np_live_ key.");
    return new Paymentsnp({
      apiKey,
      baseUrl: v["base-url"] ?? io.env.PAYMENTSNP_BASE_URL,
      fetch: io.fetch,
    });
  };

  try {
    switch (`${group} ${command ?? ""}`.trim()) {
      case "checkout create": {
        const customer =
          v.email || v.phone ? { email: v.email, phone: v.phone } : undefined;
        print(
          await client().checkout.sessions.create(
            {
              order_id: need(v.order, "--order"),
              amount_minor: toPaisa(need(v.amount, "--amount")),
              currency: "NPR",
              ...(v.description ? { description: v.description } : {}),
              ...(customer ? { customer } : {}),
              ...(v["success-url"] ? { success_url: v["success-url"] } : {}),
              ...(v["cancel-url"] ? { cancel_url: v["cancel-url"] } : {}),
            },
            { idempotencyKey: v["idempotency-key"] },
          ),
        );
        return 0;
      }
      case "checkout get":
        print(await client().checkout.sessions.retrieve(need(arg, "<session_id>")));
        return 0;
      case "checkout expire":
        print(await client().checkout.sessions.expire(need(arg, "<session_id>")));
        return 0;
      case "payments list":
        print(
          await client().payments.list({
            limit: int(v.limit, "--limit"),
            offset: int(v.offset, "--offset"),
          }),
          ["id", "order_id", "provider", "amount_minor", "provider_transaction_id", "verified_at"],
        );
        return 0;
      case "payments get":
        print(await client().payments.retrieve(need(arg, "<payment_id>")));
        return 0;
      case "invoices list":
        print(
          await client().invoices.list({
            status: v.status as never,
            limit: int(v.limit, "--limit"),
          }),
          ["id", "invoice_number", "status", "customer_name", "amount_minor", "due_date"],
        );
        return 0;
      case "webhooks verify": {
        const body = await read(need(v.file, "--file"));
        const event = await webhooks.constructEvent(
          body,
          need(v.header, "--header"),
          secret(),
          // Local files are often older than 5 minutes; still check the signature.
          { toleranceSeconds: Number.MAX_SAFE_INTEGER },
        );
        if (v.json) print({ valid: true, event });
        else io.stdout(`Signature valid: ${event.type} ${event.id}\n`);
        return 0;
      }
      case "webhooks sign": {
        const body = await read(need(v.file, "--file"));
        const header = await webhooks.generateTestHeader(
          body,
          secret(),
          int(v.timestamp, "--timestamp"),
        );
        if (v.json) print({ header: `Paymentnp-Signature: ${header}`, signature: header });
        else io.stdout(`${header}\n`);
        return 0;
      }
      default:
        throw new UsageError(`Unknown command: ${positionals.join(" ")}`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`${error.message}\n\n${usage}`);
      return 2;
    }
    if (error instanceof PaymentsnpError) {
      if (v.json)
        io.stderr(
          JSON.stringify({
            error: {
              type: error.name,
              status: error.status,
              code: error.code,
              message: error.message,
              request_id: error.requestId,
            },
          }) + "\n",
        );
      else
        io.stderr(
          `${error.name} (${error.code}${error.status ? `, HTTP ${error.status}` : ""}): ${error.message}${error.requestId ? ` [request ${error.requestId}]` : ""}\n`,
        );
      return 1;
    }
    io.stderr(`${(error as Error).message}\n`);
    return 1;
  }
}
