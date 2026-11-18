/**
 * Jev reconcile (static part): authority, injection, relevance, duplicates, recency, requests, self-consistency.
 * Plan-dependent checks (supplier below requirement, validity rollback) live in pipeline.ts.
 */
import { canon, compareRecency, fmtValue, mayAuthor, slotOf } from "../facts";
import type { Decision, Fact, Message } from "../types";

/** Strong markers that a quoted value is from the past (bare "was"/"tha" deliberately excluded: "budget was cut to" is a change). */
const PAST = /\b(last year|previous year|last time|pichle saal|pichhle saal|pichli (dafa|baar)|pichle (event|hackathon)|old rate|old price|previously|used to be|purana|purani|purane|former(ly)?)\b/i;

/** Same sender if one name's meaningful words are all contained in the other's ("Student society" ⊂ "Student Society (Hamza)"). */
const CHANNEL_WORDS = new Set(["whatsapp", "email", "mail", "sms", "msg", "message", "via", "re", "fw", "fwd", "from"]);
function sameSender(a: string | null, b: string | null): boolean {
  const words = (s: string | null) => canon(s).split(" ").filter((w) => w.length > 1 && !CHANNEL_WORDS.has(w));
  const wa = words(a), wb = words(b);
  if (!wa.length || !wb.length) return false;
  return wa.every((w) => wb.includes(w)) || wb.every((w) => wa.includes(w));
}

/** Authority rank used only for the role lock (generic roles). */
const RANK: Record<string, number> = {
  top_authority: 5, finance: 4, venue_provider: 3, caterer: 3, judging_coordinator: 3, judge: 2, staff: 1, participant: 0, other_vendor: 0, unknown: 0,
};

const DIET = /\b(veg|vegetarian|vegan|halal|gluten|diabetic|jain|allerg\w*|kosher|lactose|nut[- ]?free|sabzi)\b/i;

/** Markers that the quoted value is the current one (beats a past marker in the same evidence). */
const CURRENT = /\b(final|now|ab|abhi|is dafa|is baar|this year|this time|current|revised|updated|new|naya|nayi)\b/i;
/** Weak past markers: only used to break a tie between two values for the same slot in one message. */
const WEAK_PAST = /\b(tha|thi|thay|the|was|were|pehle|pehlay|earlier|previous|last)\b/i;
const MONEY_KEYS = new Set(["event.budget_total", "venue.price", "food.price", "food.fee", "judging.fee", "budget.committed", "budget.reserve", "budget.request"]);

const NUMERIC_SCALARS = new Set(["event.participants", "event.staff", "event.teams", "event.budget_total", "event.team_size", "people.extra", "judging.confirmed"]);

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

  // Role lock: a sender keeps the role of their first message; a later claim to a higher role is not accepted.
  const prior = m.sender ? all.find((o) => o !== m && o.seq < m.seq && sameSender(o.sender, m.sender) && o.role !== "unknown") : undefined;
  if (prior && RANK[m.role] > RANK[prior.role]) {
    decisions.push({ batch, kind: "info", ref: m.ref, reason: `${m.ref}: ${m.sender} wrote as ${prior.role} in ${prior.ref}; claim to be ${m.role} not accepted (role locked)` });
    m.role = prior.role;
  }

  // A sender typed only as unknown/other_vendor whose name says what they supply gets that provider role
  // (generic words only; organiser/finance roles are never inferred from a name).
  if ((m.role === "unknown" || m.role === "other_vendor") && m.sender) {
    const s = canon(m.sender);
    const inferred = /cater|kitchen|food|lunch|meal|tiffin|bakery|restaurant|dhaba|bawarchi/.test(s)
      ? "caterer"
      : /\bhall|venue|banquet|auditorium|spaces?\b|rooms?\b|booking|marquee|lawn/.test(s)
        ? "venue_provider"
        : null;
    if (inferred && m.facts.some((f) => mayAuthor(inferred, f.key)) && !m.facts.some((f) => f.key.startsWith("event.") || f.key.startsWith("budget."))) {
      decisions.push({ batch, kind: "info", ref: m.ref, reason: `${m.ref}: sender "${m.sender}" supplies ${inferred === "caterer" ? "food" : "venues"} — treated as ${inferred}` });
      m.role = inferred;
    }
  }

  // An institutional sender (office/department/desk/committee) is staff, not a participant or vendor.
  if ((m.role === "participant" || m.role === "unknown" || m.role === "other_vendor") && m.sender && /\b(office|department|dept|desk|committee|cell|directorate)\b/i.test(m.sender)) {
    decisions.push({ batch, kind: "info", ref: m.ref, reason: `${m.ref}: "${m.sender}" is an institutional office — treated as staff` });
    m.role = "staff";
  }
  // No organiser in the session yet: the first official (non-participant) sender who sets the event basics
  // (headcount or budget) is the event authority. Participants never qualify; later senders never override one.
  if ((m.role === "staff" || m.role === "unknown" || m.role === "other_vendor") && !all.some((o) => o !== m && o.role === "top_authority") &&
      m.facts.some((f) => (f.key === "event.participants" || f.key === "event.budget_total") && typeof f.num === "number")) {
    decisions.push({ batch, kind: "info", ref: m.ref, reason: `${m.ref}: no organiser yet and "${m.sender}" sets the event basics — treated as the event authority` });
    m.role = "top_authority";
  }
  // A caterer's percentage charge (service charge etc.) is a food fee, whatever key the model chose.
  if (m.role === "caterer")
    for (const f of m.facts)
      if ((f.key.startsWith("budget.") || f.key === "custom" || f.key === "info") && typeof f.num === "number" && (f.unit === "percent" || f.basis === "percent" || /%|percent|service/i.test(`${f.evidence} ${f.text ?? ""}`))) {
        decisions.push({ batch, kind: "info", ref: m.ref, reason: `${m.ref} "${f.evidence}": a caterer's percentage charge is a food fee` });
        f.key = "food.fee";
        f.entity = f.entity ?? "service charge";
        f.basis = "percent";
        f.unit = "percent";
      }

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
    // "teams of N" / "N-member teams" / "N ka team" / "N per team" state a team SIZE, never a team count
    if (f.key === "event.teams" && typeof f.num === "number") {
      const size = /teams?\s+of\s+(\d+)|(\d+)\s*[- ]?(?:member|person|people|student|participant)s?\s+teams?|(\d+)\s+(?:ka|ki|ke)\s+team|(\d+)\s+(?:per|in each|in a)\s+team/i.exec(f.evidence);
      if (size && Number(size[1] ?? size[2] ?? size[3] ?? size[4]) === f.num) {
        decisions.push({ batch, kind: "info", ref: m.ref, reason: `${m.ref} "${f.evidence}" states a team size, not a team count — read as event.team_size=${f.num}` });
        f.key = "event.team_size";
      }
    }
    // a diet group is a subset of the meal count, never extra people
    if ((f.key === "feed.include" || f.key === "people.extra") && DIET.test(`${f.entity ?? ""} ${f.evidence}`)) {
      decisions.push({ batch, kind: "info", ref: m.ref, reason: `${m.ref} "${f.evidence}": a diet count is part of the meal count — read as food.require` });
      f.key = "food.require";
    }
    if (f.key !== "info" && PAST.test(f.evidence) && !CURRENT.test(f.evidence)) {
      decisions.push({ batch, kind: "info", ref: m.ref, reason: `${m.ref} "${f.evidence}" is history (evidence says past) — not used as ${f.key}` });
      f.key = "info";
    } else if (f.key === "food.quantity" && m.role !== "caterer" && m.role !== "other_vendor") {
      decisions.push({ batch, kind: "info", ref: m.ref, reason: `${m.ref} "${f.evidence}": a meal quantity limit only counts from a supplier (sender is ${m.role})` });
      f.key = "info";
    }
  }

  // One value per slot within a single message: keep the best-supported candidate, log the rest.
  const bySlot = new Map<string, Fact[]>();
  for (const f of m.facts) {
    if (["info", "custom", "total", "budget.request", "venue.attr", "venue.require_attr", "schedule.forbid_window"].includes(f.key)) continue;
    const s = slotOf(f);
    bySlot.set(s, [...(bySlot.get(s) ?? []), f]);
  }
  for (const group of bySlot.values()) {
    if (group.length < 2) continue;
    const score = (f: Fact) =>
      (MONEY_KEYS.has(f.key) && f.unit === "pkr" ? 4 : 0) + (/\d/.test(f.evidence) ? 2 : 0) - (WEAK_PAST.test(f.evidence) ? 5 : 0) + (f.op === "set" ? 1 : 0);
    const best = [...group].sort((a, b) => score(b) - score(a) || group.indexOf(a) - group.indexOf(b))[0];
    for (const f of group)
      if (f !== best && (f.num !== best.num || f.text !== best.text)) {
        decisions.push({ batch, kind: "info", ref: m.ref, reason: `${m.ref} gives ${f.key}${f.entity ? `[${f.entity}]` : ""} twice: kept ${fmtValue(best)} ("${best.evidence}"), ignored ${fmtValue(f)} ("${f.evidence}")` });
        f.key = "info";
      } else if (f !== best) f.key = "info";
  }

  const activeOf = (key: string) => all.filter((o) => o !== m).flatMap((o) => o.facts.filter((g) => g.status === "active" && g.key === key && g.op !== "remove"));

  // Judges: "N withdrew, we now have M" — if M + N equals the previous count, M is already net of the withdrawals.
  const newCount = m.facts.find((f) => f.key === "judging.confirmed" && !f.entity && typeof f.num === "number");
  const withdrawCounts = m.facts.filter((f) => f.key === "judging.withdrawn" && !f.entity && typeof f.num === "number");
  const prevCount = activeOf("judging.confirmed").filter((g) => !g.entity && typeof g.num === "number").pop()?.num;
  const prevNamed = activeOf("judging.confirmed").filter((g) => g.entity).length;
  const prevTotal = Math.max(prevCount ?? 0, prevNamed);
  if (newCount && withdrawCounts.length && prevTotal && newCount.num! + withdrawCounts.reduce((s, f) => s + f.num!, 0) === prevTotal) {
    for (const w of withdrawCounts) w.key = "info";
    decisions.push({ batch, kind: "info", ref: m.ref, reason: `${m.ref}: ${newCount.num} confirmed is already net of the withdrawals (${prevTotal} before) — not subtracted twice` });
  }
  // Staff increase + "feed this group" of the same size in one message = the same people (staff are fed already).
  for (const s of m.facts.filter((f) => f.key === "event.staff" && typeof f.num === "number")) {
    const prevStaff = activeOf("event.staff").pop()?.num ?? 0;
    const delta = s.op === "add" ? s.num! : s.num! - prevStaff;
    if (delta <= 0) continue;
    for (const g of m.facts.filter((f) => (f.key === "feed.include" || f.key === "people.extra") && f.num === delta)) {
      decisions.push({ batch, kind: "info", ref: m.ref, reason: `${m.ref}: ${g.entity ?? "group"} (${delta}) is the staff increase already — staff are on site and fed, not counted twice` });
      g.key = "info";
    }
  }

  const reasons: string[] = [];
  const supersededBy: string[] = [];
  const infoOnly: string[] = [];
  const activeFacts = () => all.filter((o) => o !== m).flatMap((o) => o.facts.filter((f) => f.status === "active").map((f) => ({ f, o })));

  for (const f of m.facts) {
    if (f.key === "info") {
      f.status = "rejected";
      f.reason = "info only";
      continue;
    }
    if (!mayAuthor(m.role, f.key) && f.key === "custom") {
      // a note from someone who can't set constraints (e.g. a judge running late) is information, not a rejection
      f.status = "rejected";
      f.reason = `information only (${m.role} cannot set constraints)`;
      infoOnly.push(f.text ?? f.evidence);
      continue;
    }
    if (!mayAuthor(m.role, f.key) && f.key !== "event.budget_total" && !activeFacts().some(({ f: g }) => slotOf(g) === slotOf(f))) {
      // nothing to override: an offer/note from someone who can't set values is information, not a rejection
      f.status = "rejected";
      f.reason = `information only (${m.role} cannot set ${f.key})`;
      infoOnly.push(`${f.key}${f.entity ? `[${f.entity}]` : ""} ${fmtValue(f)}`.trim());
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
      m.reason = infoOnly.length ? `information only, no effect on the plan: ${infoOnly.join("; ")}` : `no plan facts (${m.summary})`;
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
