/**
 * Trace renderers (terminal with colour, file without). Model name and token counts are printed exactly as
 * recorded from the API response; nothing here estimates or relabels them.
 */
import type { CallRecord } from "./llm";
import type { BatchInfo, Check, Decision, Message, SessionState } from "./types";

export interface Paint {
  b: (s: string) => string;
  dim: (s: string) => string;
  red: (s: string) => string;
  green: (s: string) => string;
  yellow: (s: string) => string;
  cyan: (s: string) => string;
  magenta: (s: string) => string;
}
const wrap = (code: string) => (s: string) => `\x1b[${code}m${s}\x1b[0m`;
export const COLOR: Paint = { b: wrap("1"), dim: wrap("2"), red: wrap("31"), green: wrap("32"), yellow: wrap("33"), cyan: wrap("36"), magenta: wrap("35") };
export const PLAIN: Paint = { b: (s) => s, dim: (s) => s, red: (s) => s, green: (s) => s, yellow: (s) => s, cyan: (s) => s, magenta: (s) => s };

const indent = (s: string, pad: string) => s.split("\n").map((l, i) => (i === 0 ? l : pad + l)).join("\n");

export function tokensOf(calls: CallRecord[]) {
  const t = { prompt: 0, completion: 0, total: 0, cached: 0, reasoning: 0 };
  for (const c of calls) {
    if (!c.usage) continue;
    t.prompt += c.usage.prompt_tokens ?? 0;
    t.completion += c.usage.completion_tokens ?? 0;
    t.total += c.usage.total_tokens ?? 0;
    t.cached += c.usage.cached_tokens ?? 0;
    t.reasoning += c.usage.reasoning_tokens ?? 0;
  }
  return t;
}
const fmtTok = (t: ReturnType<typeof tokensOf>) => `prompt=${t.prompt} completion=${t.completion} total=${t.total}  (cached=${t.cached} reasoning=${t.reasoning})`;

export function renderCall(c: CallRecord, p: Paint): string {
  const u = c.usage;
  const head = `${p.b(`#${c.seq}`)}  area=${p.cyan(c.area)}  model=${p.magenta(c.model)}  latency=${(c.latency_ms / 1000).toFixed(2)}s${c.retry_of ? `  (retry of #${c.retry_of})` : ""}${c.error ? `  ${p.red(`ERROR ${c.error}`)}` : ""}`;
  const tokens = u
    ? `prompt=${u.prompt_tokens} completion=${u.completion_tokens} total=${u.total_tokens}  cached=${u.cached_tokens ?? "n/a"} reasoning=${u.reasoning_tokens ?? "n/a"}   (as reported by API)`
    : "(API returned no usage object)";
  return [
    head,
    `    INPUT   ▸ ${indent(`[system]\n${c.system}\n[user]\n${c.user}`, "              ")}`,
    `    OUTPUT  ▸ ${indent(c.output || "(empty)", "              ")}`,
    `    TOKENS  ▸ ${tokens}`,
  ].join("\n");
}

const SYM: Record<string, (p: Paint) => string> = {
  applied: (p) => p.green("✓ applied    "),
  superseded: (p) => p.yellow("↺ superseded "),
  irrelevant: (p) => p.dim("⊘ irrelevant "),
  request: (p) => p.cyan("? request    "),
  rejected: (p) => p.red("✗ REJECTED   "),
  duplicate: (p) => p.dim("≡ duplicate  "),
  needs_decision: (p) => p.yellow("⚠ HELD       "),
  fallback: (p) => p.magenta("⇢ fallback   "),
  cap: (p) => p.yellow("⏱ cap        "),
  info: (p) => p.dim("· info       "),
};

export function renderChecks(checks: Check[], p: Paint): string {
  const six = checks.filter((c) => c.id !== "constraint");
  const strip = six.map((c) => (c.pass ? p.green(`✓ ${c.id}`) : p.red(`✗ ${c.id}`))).join(" ");
  const lines = checks.map((c) => `    ${c.pass ? p.green("✓") : c.advisory ? p.yellow("⚠") : p.red("✗")} ${c.label}: ${c.detail}`);
  return `CHECKS  ${strip}\n${lines.join("\n")}`;
}

export function renderBatch(state: SessionState, b: BatchInfo, p: Paint, opts: { full?: boolean } = {}): string {
  const calls = state.calls.filter((c) => b.calls.includes(c.seq));
  const msgs = state.messages.filter((m) => m.batch === b.batch);
  const decisions = state.decisions.filter((d) => d.batch === b.batch);
  const out: string[] = [];
  out.push(p.b(`═══ BATCH ${b.batch} · ${b.file} · ${msgs.length} message${msgs.length === 1 ? "" : "s"} ═══`));
  for (const c of calls) out.push(opts.full === false ? renderCall({ ...c, system: "(system prompt, see out/trace.txt)", user: c.user.length > 400 ? `${c.user.slice(0, 400)}…` : c.user }, p) : renderCall(c, p));
  out.push(p.b("JEV (code, 0 tokens)"));
  out.push(...renderDecisions(msgs, decisions, state, p));
  out.push(renderChecks(state.checks, p));
  const bt = tokensOf(calls);
  const st = tokensOf(state.calls.filter((c) => state.batches.some((x) => x.batch <= b.batch && x.calls.includes(c.seq))));
  out.push(`TOKENS this batch: ${fmtTok(bt)}`);
  out.push(`TOKENS session:    ${fmtTok(st)}`);
  out.push(`Model-call areas this batch: ${b.areas_called.length ? b.areas_called.join(", ") : "none"}`);
  out.push(`Recomputed by Jev (0 tokens): ${b.areas_recomputed.join(", ") || "none"}`);
  if (b.batch > 1) out.push(`Plan diff: ${b.diff.length ? "" : "no figure changed"}`);
  for (const d of b.batch > 1 ? b.diff : []) out.push(`    ${d.path}: ${d.old} → ${p.b(d.new)}`);
  if (b.error) out.push(p.red(`BATCH ERROR: ${b.error}`));
  out.push(`(${(b.duration_ms / 1000).toFixed(1)} s, ${calls.length} model call${calls.length === 1 ? "" : "s"})`);
  return out.join("\n");
}

function renderDecisions(msgs: Message[], decisions: Decision[], state: SessionState, p: Paint): string[] {
  const lines: string[] = [];
  const plan = state.plan;
  for (const m of msgs) {
    const sym = SYM[m.status]?.(p) ?? m.status;
    if (m.status === "request") {
      const reqs = plan?.requests.filter((r) => r.ref === m.ref) ?? [];
      const r = reqs.map((x) => `${x.label}${x.amount !== null ? ` Rs ${x.amount.toLocaleString()}` : ""} (affordable: ${x.affordable === null ? "n/a" : x.affordable ? "yes" : "no"}, ${x.approved ? "approved" : "not committed"})`).join("; ");
      lines.push(`    ${sym} ${m.ref} ${r || m.reason}`);
    } else lines.push(`    ${sym} ${m.ref} ${m.status === "applied" ? m.reason || m.summary : m.reason}`);
  }
  for (const d of decisions) {
    if (d.kind === "superseded" && !msgs.some((m) => m.ref === d.ref && m.status === "superseded")) lines.push(`    ${SYM.superseded(p)} ${d.reason}`);
    else if (d.kind === "fallback" || d.kind === "cap" || d.kind === "info") lines.push(`    ${SYM[d.kind](p)} ${d.ref ?? ""} ${d.reason}`);
  }
  return lines;
}

export function renderTraceFile(state: SessionState): string {
  return state.batches.map((b) => renderBatch(state, b, PLAIN)).join("\n\n");
}
