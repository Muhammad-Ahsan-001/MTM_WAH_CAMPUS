/**
 * callModel — the ONLY function in the engine that makes model calls (scripts/openai-smoke.ts additionally lists
 * available model ids via GET /v1/models, which is not a model call).
 * Every call is recorded with: global seq, area tag, the model name taken from the response's `model` field,
 * the full input and raw output, the usage object exactly as returned, and latency.
 */
import { requireEnv } from "./env";

export const AREAS = ["reading", "venue", "schedule", "food", "judging", "budget"] as const;
export type Area = (typeof AREAS)[number];

/** Token counts copied verbatim from the API response's `usage` object (null when the API sent none). */
export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cached_tokens: number | null;
  reasoning_tokens: number | null;
}

export interface CallRecord {
  seq: number;
  batch: number;
  area: Area;
  /** Exactly response.model; "(no response)" only when the request failed before any response body. */
  model: string;
  requested_model: string;
  system: string;
  user: string;
  output: string;
  usage: Usage | null;
  usage_raw: unknown;
  latency_ms: number;
  ok: boolean;
  error?: string;
  retry_of?: number;
}

/** Per-batch call ledger: assigns global sequence numbers, enforces the call cap, collects records. */
export class CallLedger {
  calls: CallRecord[] = [];
  constructor(
    public batch: number,
    private nextSeq: number,
    public readonly maxCalls: number,
    /** Epoch ms by which every call must finish (batch time cap). */
    public readonly deadline: number = Date.now() + 110_000,
  ) {}
  msLeft(): number {
    return this.deadline - Date.now();
  }
  get used(): number {
    return this.calls.length;
  }
  remaining(): number {
    return this.maxCalls - this.calls.length;
  }
  takeSeq(): number {
    return this.nextSeq++;
  }
  peekNextSeq(): number {
    return this.nextSeq;
  }
}

export class CallCapError extends Error {}

export interface ModelRequest<T> {
  area: Area;
  system: string;
  user: string;
  schemaName: string;
  /** JSON Schema for OpenAI structured outputs (strict). */
  schema: Record<string, unknown>;
  /** Zod (or equivalent) validation of the parsed output. */
  parse: (value: unknown) => T;
  /** Override OPENAI_MODEL (used by the smoke test to compare candidates). */
  model?: string;
  maxCompletionTokens?: number;
}

const TIMEOUT_MS = 45_000;
const URL = "https://api.openai.com/v1/chat/completions";

function isReasoningModel(model: string): boolean {
  return /^(o\d|gpt-5)/i.test(model);
}

function defaultEffort(model: string): string | undefined {
  const env = process.env.OPENAI_REASONING_EFFORT?.trim();
  if (env) return env;
  if (/^gpt-5(-mini|-nano)?($|-\d)/i.test(model)) return "minimal"; // gpt-5 family: lowest effort is "minimal"
  if (/^gpt-5\.\d/i.test(model)) return "none"; // gpt-5.x (x>=1): lowest effort is "none"
  if (isReasoningModel(model)) return "low";
  return undefined;
}

function toUsage(u: any): Usage | null {
  if (!u || typeof u !== "object") return null;
  return {
    prompt_tokens: u.prompt_tokens,
    completion_tokens: u.completion_tokens,
    total_tokens: u.total_tokens,
    cached_tokens: u.prompt_tokens_details?.cached_tokens ?? null,
    reasoning_tokens: u.completion_tokens_details?.reasoning_tokens ?? null,
  };
}

class RetryableError extends Error {}

async function attempt<T>(ledger: CallLedger, req: ModelRequest<T>, retryOf?: number): Promise<{ data: T; record: CallRecord }> {
  if (ledger.remaining() <= 0) throw new CallCapError(`call cap reached (${ledger.maxCalls} per batch)`);
  const timeout = Math.min(TIMEOUT_MS, ledger.msLeft() - 1000);
  if (timeout < 3000) throw new CallCapError(`time cap reached (${Math.round(ledger.msLeft() / 1000)} s left in batch)`);
  const apiKey = requireEnv("OPENAI_API_KEY");
  const model = req.model ?? requireEnv("OPENAI_MODEL");
  const effort = defaultEffort(model);

  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: req.system },
      { role: "user", content: req.user },
    ],
    response_format: { type: "json_schema", json_schema: { name: req.schemaName, strict: true, schema: req.schema } },
    max_completion_tokens: req.maxCompletionTokens ?? 8000,
    store: false,
  };
  if (effort) body.reasoning_effort = effort;
  else body.temperature = 0;

  const record: CallRecord = {
    seq: ledger.takeSeq(),
    batch: ledger.batch,
    area: req.area,
    model: "(no response)",
    requested_model: model,
    system: req.system,
    user: req.user,
    output: "",
    usage: null,
    usage_raw: null,
    latency_ms: 0,
    ok: false,
    retry_of: retryOf,
  };
  ledger.calls.push(record);

  const t0 = performance.now();
  let res: Response;
  let text: string;
  try {
    res = await fetch(URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
    text = await res.text();
  } catch (e) {
    record.latency_ms = Math.round(performance.now() - t0);
    record.error = `network: ${(e as Error).message}`;
    throw new RetryableError(record.error);
  }
  record.latency_ms = Math.round(performance.now() - t0);

  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* handled below */
  }
  if (json?.model) record.model = String(json.model);
  record.usage_raw = json?.usage ?? null;
  record.usage = toUsage(json?.usage);

  if (!res.ok) {
    record.output = text;
    record.error = `http ${res.status}: ${json?.error?.message ?? text.slice(0, 300)}`;
    if (res.status === 429 || res.status >= 500) throw new RetryableError(record.error);
    throw new Error(record.error);
  }

  const msg = json?.choices?.[0]?.message;
  record.output = msg?.content ?? msg?.refusal ?? "";
  if (msg?.refusal) {
    record.error = `refusal: ${msg.refusal}`;
    throw new RetryableError(record.error);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(record.output);
  } catch {
    record.error = `parse: output is not JSON (finish_reason=${json?.choices?.[0]?.finish_reason})`;
    throw new RetryableError(record.error);
  }
  try {
    const data = req.parse(parsed);
    record.ok = true;
    return { data, record };
  } catch (e) {
    record.error = `schema: ${(e as Error).message.slice(0, 500)}`;
    throw new RetryableError(record.error);
  }
}

/** One model call with one retry on network/parse errors. The retry is traced as its own numbered call. */
export async function callModel<T>(ledger: CallLedger, req: ModelRequest<T>): Promise<{ data: T; record: CallRecord }> {
  try {
    return await attempt(ledger, req);
  } catch (e) {
    if (!(e instanceof RetryableError)) throw e;
    const first = ledger.calls[ledger.calls.length - 1];
    if (ledger.remaining() <= 0 || ledger.msLeft() < 4000) throw new CallCapError(`retry skipped (cap/time) after: ${e.message}`);
    // network-level back-off only (rate limit / server error): wait briefly before the single retry
    if (/http (429|5\d\d)|network/.test(e.message)) await new Promise((r) => setTimeout(r, Math.min(3000, Math.max(800, ledger.msLeft() - 30_000))));
    return await attempt(ledger, req, first?.seq);
  }
}
