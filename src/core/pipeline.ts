/**
 * Transactional batch: reading call → Jev reconcile (tentative apply, one message at a time) → solve → validate
 * → commit or rollback → area fallback for constraints the DSL cannot express. Shared by the CLI and the web route.
 */
import { fmtValue, normalizeFact, resolveEntity, entityFamily } from "./facts";
import { runFallbacks } from "./fallback";
import { CallCapError, CallLedger, callModel } from "./llm";
import { POLICY } from "./policy";
import { READING_SCHEMA, ReadingSchema, SYSTEM_PROMPT, buildReadingUser } from "./reading";
import { affectedAreas, diffPlans } from "./jev/deps";
import { reconcileMessage, rollback } from "./jev/reconcile";
import { solve } from "./jev/solve";
import { failedSummary, isValid, validate } from "./jev/validate";
import type { BatchInfo, Check, Decision, Fact, Message, Plan, SessionState } from "./types";

export function newSession(label: string, id: string): SessionState {
  return {
    version: 1,
    id,
    label,
    created_at: new Date().toISOString(),
    next_call_seq: 1,
    next_msg_seq: 1,
    messages: [],
    calls: [],
    decisions: [],
    batches: [],
    plan: null,
    checks: [],
    plan_version: 0,
  };
}

const allFacts = (s: SessionState): Fact[] => s.messages.flatMap((m) => m.facts);

/** Compact index of current facts so update messages reuse existing keys/entities (token-lean). */
export function currentFactsIndex(s: SessionState): string {
  const lines: string[] = [];
  for (const m of s.messages)
    for (const f of m.facts)
      if (f.status === "active")
        lines.push(`${f.key}${f.entity ? `[${f.entity}]` : ""}=${fmtValue(f)} (${m.role}${m.date ? `, ${m.date}` : ""})`);
  return lines.join("\n");
}

export interface BatchResult {
  batch: BatchInfo;
  problems: string[];
  notes: string[];
  newMessages: Message[];
  decisions: Decision[];
}

export async function runBatch(state: SessionState, raw: string, file: string): Promise<BatchResult> {
  const t0 = Date.now();
  const batchNo = state.batches.length + 1;
  const first = state.plan === null;
  const maxCalls = first ? POLICY.caps.fullRunCalls : POLICY.caps.updateCalls;
  const deadline = t0 + (first ? POLICY.caps.fullRunMs : POLICY.caps.updateMs);
  const ledger = new CallLedger(batchNo, state.next_call_seq, maxCalls, deadline);
  const decisions: Decision[] = [];
  const batch: BatchInfo = {
    batch: batchNo,
    file,
    at: new Date().toISOString(),
    message_refs: [],
    calls: [],
    areas_called: [],
    areas_recomputed: [],
    diff: [],
    plan_valid: false,
    duration_ms: 0,
  };
  const finish = (problems: string[] = [], notes: string[] = [], newMessages: Message[] = []): BatchResult => {
    state.calls.push(...ledger.calls);
    state.next_call_seq = ledger.peekNextSeq();
    batch.calls = ledger.calls.map((c) => c.seq);
    batch.areas_called = [...new Set(ledger.calls.map((c) => c.area))];
    batch.duration_ms = Date.now() - t0;
    state.batches.push(batch);
    state.decisions.push(...decisions);
    return { batch, problems, notes, newMessages, decisions };
  };

  batch.raw = raw;

  // ---- Exact re-send of earlier input: decided by code, 0 tokens, no model call ----
  if (!first) {
    const norm = (s: string) => s.replace(/^﻿/, "").toLowerCase().replace(/\s+/g, " ").trim();
    const n = norm(raw);
    const prev = n.length >= 40 ? state.batches.find((b) => b.raw && norm(b.raw).includes(n)) : undefined;
    if (prev) {
      const seq = state.next_msg_seq++;
      const ref = `m${seq}`;
      const reason = `exact re-send of input from batch ${prev.batch} (${prev.file}); not counted twice — detected by code, no model call`;
      const dup: Message = { ref, seq, batch: batchNo, sender: null, role: "unknown", date: null, relevance: "relevant", kind: "info", injection: false, summary: "exact re-send of earlier input", status: "duplicate", reason, facts: [] };
      state.messages.push(dup);
      batch.message_refs = [ref];
      decisions.push({ batch: batchNo, kind: "duplicate", ref, reason });
      batch.plan_valid = isValid(state.checks);
      return finish([], [], [dup]);
    }
  }

  // ---- Reading (1 model call, area=reading) ----
  let reading;
  try {
    const user = buildReadingUser(raw, state.next_msg_seq, first ? undefined : currentFactsIndex(state));
    reading = (
      await callModel(ledger, {
        area: "reading",
        system: SYSTEM_PROMPT,
        user,
        schemaName: "reading",
        schema: READING_SCHEMA as unknown as Record<string, unknown>,
        parse: (v) => ReadingSchema.parse(v),
      })
    ).data;
  } catch (e) {
    batch.error = `reading failed: ${(e as Error).message}`;
    batch.plan_valid = state.plan !== null && isValid(state.checks);
    decisions.push({ batch: batchNo, kind: "info", reason: `${batch.error} — plan unchanged` });
    return finish([batch.error]);
  }

  // ---- Build typed messages (code assigns refs; entities resolved against known names) ----
  const known = new Map<string, string[]>();
  for (const f of allFacts(state)) if (f.entity) resolveEntity(f.key, f.entity, known);
  const newMessages: Message[] = reading.messages.map((rm, i) => {
    const seq = state.next_msg_seq + i;
    const ref = `m${seq}`;
    return {
      ...rm,
      ref,
      seq,
      batch: batchNo,
      status: "applied",
      reason: "",
      facts: rm.facts.map((rf, j) => {
        const nf = normalizeFact(rf);
        return { ...nf, entity: resolveEntity(nf.key, nf.entity, known), id: `${ref}.${j + 1}`, ref, order: seq, status: "pending" as const };
      }),
    };
  });
  state.next_msg_seq += newMessages.length;
  batch.message_refs = newMessages.map((m) => m.ref);
  void entityFamily;

  const beforePlan: Plan | null = state.plan ? structuredClone(state.plan) : null;
  let prevValid = state.plan !== null && isValid(state.checks);
  const touchedAreas = new Set<string>();

  // ---- Tentative apply, one message at a time ----
  for (const m of newMessages) {
    state.messages.push(m);
    const out = reconcileMessage(m, state.messages, batchNo);
    decisions.push(...out.decisions.filter((d) => !(d.ref === m.ref && (d.kind === m.status || d.kind === "rejected"))));
    if (m.status !== "applied" && m.status !== "request") continue;

    const facts = allFacts(state);
    const { plan, problems } = solve(facts);
    const checks = validate(plan, facts, problems);

    // Supplier below requirement → reject, keep the plan (our order always equals the requirement).
    const short = m.facts.find((f) => f.key === "food.quantity" && f.status === "active" && typeof f.num === "number" && plan.food && f.num < plan.food.quantity);
    if (short && plan.food) {
      rollback(m, out, "rejected", `supplier can supply only ${short.num} (${short.entity ?? "meals"}) < required ${plan.food.quantity} people to feed; our order stays ${plan.food.quantity}`, state.messages);
      continue;
    }
    if (prevValid && !isValid(checks)) {
      rollback(m, out, "needs_decision", `not applied — it would make the plan invalid: ${failedSummary(checks)}. Last valid plan kept; needs a human decision`, state.messages);
      continue;
    }
    for (const f of m.facts) if (f.status === "active") touchedAreas.add(f.area);
    for (const g of out.superseded) touchedAreas.add(g.area);
    if (isValid(checks)) prevValid = true;
  }

  // ---- Final solve; on the first batch, find culprits if the plan is invalid ----
  let res = solve(allFacts(state));
  let checks: Check[] = validate(res.plan, allFacts(state), res.problems);
  if (!isValid(checks) && first) {
    for (const m of [...newMessages].reverse()) {
      if (m.status !== "applied" || m.role === "top_authority") continue;
      const live = m.facts.filter((f) => f.status === "active");
      const failedBefore = failedSummary(checks);
      for (const f of live) f.status = "rejected";
      const r2 = solve(allFacts(state));
      const c2 = validate(r2.plan, allFacts(state), r2.problems);
      if (isValid(c2)) {
        m.status = "rejected";
        m.reason = `rolled back — with it the plan fails: ${failedBefore}`;
        for (const f of live) f.reason = m.reason;
        res = r2;
        checks = c2;
        break;
      }
      for (const f of live) f.status = "active";
    }
  }

  // ---- Area fallback for constraints the DSL cannot express (≤1 per area per batch) ----
  const unencoded = newMessages.flatMap((m) => m.facts.filter((f) => f.key === "custom" && f.status === "active"));
  if (unencoded.length) {
    const fb = await runFallbacks(ledger, unencoded, state, res.plan);
    decisions.push(...fb.decisions);
    if (fb.changed) {
      res = solve(allFacts(state));
      checks = validate(res.plan, allFacts(state), res.problems);
    }
    res.plan.unencoded = fb.unencoded;
    checks = validate(res.plan, allFacts(state), res.problems);
  }
  // keep earlier unencoded items visible
  const prevUnencoded = beforePlan?.unencoded ?? [];
  res.plan.unencoded = [...prevUnencoded.filter((u) => !res.plan.unencoded.some((x) => x.ref === u.ref && x.text === u.text)), ...res.plan.unencoded];
  checks = validate(res.plan, allFacts(state), res.problems);

  const valid = isValid(checks);
  if (valid || !prevValidPlan(state)) {
    state.plan = res.plan;
    state.checks = checks;
    state.plan_version += 1;
  }
  for (const m of newMessages) decisions.push({ batch: batchNo, kind: m.status, ref: m.ref, reason: m.reason });
  batch.plan_valid = isValid(state.checks);
  batch.areas_recomputed = first ? ["venue", "schedule", "food", "judging", "budget"] : affectedAreas(touchedAreas);
  batch.diff = diffPlans(beforePlan, state.plan);
  return finish(res.problems, res.notes, newMessages);
}

function prevValidPlan(state: SessionState): boolean {
  return state.plan !== null && isValid(state.checks);
}

export { CallCapError };
