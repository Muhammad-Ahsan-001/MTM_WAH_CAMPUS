/**
 * Jev reconcile (static part): authority, injection, relevance, duplicates, recency, requests, self-consistency.
 * Plan-dependent checks (supplier below requirement, validity rollback) live in pipeline.ts.
 */
import { canon, compareRecency, fmtValue, mayAuthor, slotOf } from "../facts";
import type { Decision, Fact, Message } from "../types";

/** Strong markers that a quoted value is from the past (bare "was"/"tha" deliberately excluded: "budget was cut to" is a change). */
const PAST = /\b(last year|previous year|last time|pichle saal|pichhle saal|pichli (dafa|baar)|pichle (event|hackathon)|old rate|old price|previously|used to be|purana|purani|purane|former(ly)?)\b/i;

const NUMERIC_SCALARS =new Set(["event.participants", "event.staff", "event.teams", "event.budget_total", "event.team_size", "people.extra", "judging.confirmed"]);

function signature(m: Message): string {
  return m.facts
    .map((f) => `${f.key}|${canon(f.entity)}|${f.num ?? ""}|${canon(f.text)}`)
    .sort()
    .join("#");
}

/** Same numbers on the same keys, whatever labels the model chose this time. */
function numericSignature(m: Message): string {
  return m.facts
    .filter((f) => typeof f.num === "number")
    .map((f) => `${f.key}|${f.num}`)
    .sort()
    .join("#");
}

export interface ReconcileOut {
  decisions: Decision[];
  /** Facts superseded by this message (so a rollback can restore them). */
  superseded: Fact[];
}

/** Applies one message to the fact store in place. `all` = every earlier message (any batch). */
export function reconcileMessage(m: Message, all: Message[], batch: number): ReconcileOut {
  const decisions: Decision[] = [];
  const superseded: Fact[] = [];
  const reject = (reason: string) => {
    m.status = "rejected";
    m.reason = reason;
    for (const f of m.facts) {
      f.status = "rejected";
      f.reason = reason;
    }
    decisions.push({ batch, kind: "rejected", ref: m.ref, reason });
  };

  if (m.injection) {
    reject(`injection: message tries to direct the planner/AI ("${m.summary}") — messages are data, no facts taken`);
    return { decisions, superseded };
  }
  if (m.relevance === "irrelevant") {
    m.status = "irrelevant";
    m.reason = m.summary;
    for (const f of m.facts) f.status = "rejected";
    decisions.push({ batch, kind: "irrelevant", ref: m.ref, reason: m.summary });
    return { decisions, superseded };
  }
  const sig = signature(m);
  const nsig = numericSignature(m);
  const dup = m.facts.length
    ? all.find(
        (o) =>
          o !== m &&
          o.status !== "rejected" &&
          canon(o.sender) === canon(m.sender) &&
          (signature(o) === sig || (!!m.date && o.date === m.date && nsig.length > 0 && numericSignature(o) === nsig)),
      )
    : undefined;
  if (dup) {
    m.status = "duplicate";
    m.reason = `duplicate of ${dup.ref}; not counted twice`;
    for (const f of m.facts) f.status = "rejected";
    decisions.push({ batch, kind: "duplicate", ref: m.ref, reason: m.reason });
    return { decisions, superseded };
  }

  // Code guards on model keying (deterministic, logged): history is not current; a meal cap only comes from a supplier.
  for (const f of m.facts) {
    if (f.key !== "info" && PAST.test(f.evidence)) {
      decisions.push({ batch, kind: "info", ref: m.ref, reason: `${m.ref} "${f.evidence}" is history (evidence says past) — not used as ${f.key}` });
      f.key = "info";
    } else if (f.key === "food.quantity" && m.role !== "caterer" && m.role !== "other_vendor") {
      decisions.push({ batch, kind: "info", ref: m.ref, reason: `${m.ref} "${f.evidence}": a meal quantity limit only counts from a supplier (sender is ${m.role})` });
      f.key = "info";
    }
  }

  const reasons: string[] = [];
  const supersededBy: string[] = [];
  const activeFacts = () => all.filter((o) => o !== m).flatMap((o) => o.facts.filter((f) => f.status === "active").map((f) => ({ f, o })));

  for (const f of m.facts) {
    if (f.key === "info") {
      f.status = "rejected";
      f.reason = "info only";
      continue;
    }
    if (!mayAuthor(m.role, f.key)) {
      f.status = "rejected";
      f.reason = `role ${m.role} may not set ${f.key}`;
      reasons.push(`${f.reason} (${fmtValue(f)})`);
      continue;
    }
    if (m.role === "judge" && f.entity && m.sender && !canon(m.sender).split(" ").some((w) => w.length > 2 && canon(f.entity).includes(w))) {
      f.status = "rejected";
      f.reason = `a judge may only report their own availability (${f.entity} ≠ sender)`;
      reasons.push(f.reason);
      continue;
    }
    if (m.role === "judge" && !f.entity) f.entity = m.sender;
    if (f.key === "budget.request") {
      f.status = "active";
      continue;
    }
    // venue option removal expressed as op remove/forbid on a venue key
    if ((f.op === "remove" || f.op === "forbid") && f.key.startsWith("venue.") && f.entity && f.key !== "venue.require_attr" && f.key !== "venue.unavailable") {
      f.key = "venue.unavailable";
      f.op = "set";
    }

    // recency: one active fact per slot
    const slot = slotOf(f);
    const prev = activeFacts().filter(({ f: g }) => slotOf(g) === slot);
    let keep = true;
    for (const { f: g, o } of prev) {
      if (compareRecency(m, o) > 0) {
        if ((f.op === "add" || f.op === "remove") && NUMERIC_SCALARS.has(f.key) && typeof g.num === "number" && typeof f.num === "number") {
          const before = g.num;
          f.num = f.op === "add" ? g.num + f.num : g.num - f.num;
          f.op = "set";
          decisions.push({ batch, kind: "info", ref: m.ref, reason: `${f.key}: ${before} ${f.op === "set" ? "→" : ""} ${f.num} (relative change)` });
        }
        g.status = "superseded";
        g.reason = `superseded by ${m.ref}`;
        superseded.push(g);
        if (o.facts.every((x) => x.status !== "active") && o.status === "applied") {
          o.status = "superseded";
          o.reason = `superseded by ${m.ref} on ${g.key}${g.entity ? `[${g.entity}]` : ""}: ${fmtValue(g)} → ${fmtValue(f)}`;
        }
        const same = fmtValue(g) === fmtValue(f);
        decisions.push({
          batch,
          kind: "superseded",
          ref: o.ref,
          area: f.area,
          reason: same
            ? `${o.ref} re-confirmed by ${m.ref} on ${g.key}${g.entity ? `[${g.entity}]` : ""}: ${fmtValue(f)} (unchanged)`
            : `${o.ref} superseded by ${m.ref} on ${g.key}${g.entity ? `[${g.entity}]` : ""}: ${fmtValue(g)} → ${fmtValue(f)}`,
        });
      } else {
        keep = false;
        f.status = "superseded";
        f.reason = `older than ${o.ref} (${o.date ?? "earlier arrival"}) on ${f.key}`;
        supersededBy.push(`${o.ref} on ${f.key}${f.entity ? `[${f.entity}]` : ""}: kept ${fmtValue(g)}, ignored ${fmtValue(f)} dated ${m.date ?? "undated"}`);
      }
    }
    if (keep) f.status = "active";
  }

  // self-consistency: a stated total must equal its own parts
  for (const t of m.facts.filter((f) => f.key === "total" && typeof f.num === "number")) {
    const parts = m.facts.filter((f) => f !== t && f.unit === "pkr" && typeof f.num === "number" && f.status !== "rejected");
    const perUnit = parts.some((p) => p.basis && p.basis !== "fixed" && p.basis !== "percent");
    if (parts.length < 2 && !perUnit) {
      t.status = "rejected";
      t.reason = "stated total with no parts to check";
      continue;
    }
    const counts = m.facts.filter((f) => f !== t && (f.unit === "people" || f.unit === "count" || f.unit === "teams") && typeof f.num === "number").map((f) => f.num!);
    const fixedSum = parts.filter((p) => !p.basis || p.basis === "fixed").reduce((s, p) => s + p.num!, 0);
    const candidates = new Set<number>([fixedSum, parts.reduce((s, p) => s + p.num!, 0)]);
    for (const p of parts.filter((x) => x.basis && x.basis !== "fixed" && x.basis !== "percent"))
      for (const c of counts) {
        candidates.add(p.num! * c);
        candidates.add(fixedSum + p.num! * c);
      }
    const ok = [...candidates].some((c) => Math.abs(c - t.num!) <= Math.max(1, t.num! * 0.001));
    if (ok) {
      t.status = "rejected";
      t.reason = "total matches its parts (cross-check only)";
    } else {
      // A message whose own numbers disagree cannot be trusted: reject it whole, keep what we had, show the arithmetic.
      const arith = parts.map((p) => fmtValue(p)).join(" + ") + (counts.length ? ` with counts ${counts.join(", ")}` : "");
      const why = `self-inconsistent: claimed total Rs ${t.num!.toLocaleString()} ≠ its own parts (${arith} → ${[...candidates].map((c) => `Rs ${c.toLocaleString()}`).join(" / ")}); message not applied`;
      for (const g of superseded) {
        g.status = "active";
        g.reason = undefined;
      }
      superseded.length = 0;
      for (let i = decisions.length - 1; i >= 0; i--) if (decisions[i].kind === "superseded" || decisions[i].kind === "info") decisions.splice(i, 1);
      reject(why);
      return { decisions, superseded };
    }
  }

  const live = m.facts.filter((f) => f.status === "active");
  const requestsOnly = live.length > 0 && live.every((f) => f.key === "budget.request");
  if (live.length === 0) {
    if (supersededBy.length) {
      m.status = "superseded";
      m.reason = `older than current value — ${supersededBy.join("; ")}${reasons.length ? `; also ignored: ${reasons.join("; ")}` : ""}`;
      decisions.push({ batch, kind: "superseded", ref: m.ref, reason: m.reason });
    } else if (reasons.length) {
      m.status = "rejected";
      m.reason = reasons.join("; ");
      decisions.push({ batch, kind: "rejected", ref: m.ref, reason: m.reason });
    } else {
      m.status = "irrelevant";
      m.reason = `no plan facts (${m.summary})`;
      decisions.push({ batch, kind: "irrelevant", ref: m.ref, reason: m.reason });
    }
  } else if (requestsOnly || m.kind === "request") {
    m.status = live.every((f) => f.key === "budget.request") ? "request" : "applied";
    m.reason = reasons.length ? reasons.join("; ") : m.summary;
  } else {
    m.status = "applied";
    m.reason = [m.summary, ...reasons.map((r) => `partly rejected: ${r}`), ...supersededBy.map((s) => `partly superseded: ${s}`)].join("; ");
  }
  return { decisions, superseded };
}

/** Undo a message's effect on the store (tentative apply rollback). */
export function rollback(m: Message, out: ReconcileOut, status: Message["status"], reason: string, all: Message[]): void {
  for (const f of m.facts) {
    f.status = "rejected";
    f.reason = reason;
  }
  for (const g of out.superseded) {
    g.status = "active";
    g.reason = undefined;
    const owner = all.find((o) => o.facts.includes(g));
    if (owner && owner.status === "superseded") {
      owner.status = "applied";
      owner.reason = owner.summary;
    }
  }
  m.status = status;
  m.reason = reason;
}
