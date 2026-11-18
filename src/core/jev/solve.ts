/**
 * Jev solve: computes every figure and choice from active facts. Zero tokens. No pack values live here.
 */
import { canon } from "../facts";
import { POLICY } from "../policy";
import type { Fact, LineItem, Plan, ScheduleBlock } from "../types";

export interface SolveResult {
  plan: Plan;
  problems: string[]; // infeasibility / missing data, with numbers
  notes: string[]; // policy choices made, for the trace
}

const ceil = Math.ceil;
const refsOf = (...fs: (Fact | undefined)[]) => [...new Set(fs.filter(Boolean).map((f) => f!.ref))];
const isPct = (f?: Fact) => !!f && (f.unit === "percent" || f.basis === "percent");

export function toMin(clock: string | null | undefined): number | null {
  if (!clock) return null;
  const m = /(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?/i.exec(clock.trim());
  if (!m) return null;
  let h = Number(m[1]);
  const mm = m[2] ? Number(m[2]) : 0;
  const ap = m[3]?.toLowerCase();
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  if (h > 23 || mm > 59) return null;
  return h * 60 + mm;
}
export const isBuildLabel = (s: string | null | undefined) => /build|hack|coding|remaining|baqi/.test(canon(s));
export const hasClock =(s: string | null | undefined) => !!s && /\d{1,2}\s*[:.]\s*\d{2}|\d\s*(am|pm)\b|\bbaje\b|\bnoon\b|\bdopahar\b/i.test(s);

export function fmtClock(startMin: number | null, offset: number): string {
  if (startMin === null) {
    const h = Math.floor(offset / 60);
    const m = offset % 60;
    return `T+${h}:${String(m).padStart(2, "0")}`;
  }
  const t = (startMin + offset) % (24 * 60);
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

class View {
  constructor(private facts: Fact[]) {}
  get(key: string): Fact | undefined {
    const xs = this.facts.filter((f) => f.key === key && f.status === "active" && f.op !== "remove");
    return xs[xs.length - 1];
  }
  num(key: string): number | null {
    const f = this.get(key);
    return f && typeof f.num === "number" ? f.num : null;
  }
  /** Active facts asserting a value. A "remove" fact only cancels the earlier value in its slot (no effect itself). */
  each(key: string): Fact[] {
    // "forbid venue.unavailable" = "is available" (a double negative), so forbid only asserts for forbid_window.
    return this.facts.filter((f) => f.key === key && f.status === "active" && f.op !== "remove" && !(f.op === "forbid" && key !== "schedule.forbid_window"));
  }
}

function attrTokens(f: Fact): string[] {
  const out = [...f.attrs];
  if (f.key === "venue.attr" || f.key === "venue.require_attr") {
    if (f.text) out.push(f.text);
    if (f.key === "venue.require_attr" && f.entity) out.push(f.entity);
  }
  return out.map((a) => canon(a).replace(/\s+/g, "_")).filter(Boolean);
}
const attrMatch = (have: string[], want: string) =>
  have.some((h) => h === want || h.includes(want) || want.includes(h) || h.split("_").filter((w) => w.length > 2).some((w) => want.split("_").includes(w)));

export function solve(facts: Fact[], opts: { judgesUsedOverride?: number } = {}): SolveResult {
  const v = new View(facts);
  const problems: string[] = [];
  const notes: string[] = [];

  // ---------- Event ----------
  const fParticipants = v.get("event.participants");
  const participants = v.num("event.participants") ?? 0;
  if (!fParticipants) problems.push("participants not stated");
  const teamSize = v.num("event.team_size");
  const fTeams = v.get("event.teams");
  const teams = fTeams?.num ?? (teamSize ? ceil(participants / teamSize) : 0);
  if (!fTeams && !teamSize) problems.push("neither team count nor team size stated");
  const staff = v.num("event.staff") ?? 0;
  const extras = v.each("people.extra").filter((f) => typeof f.num === "number").map((f) => ({ group: f.entity ?? "extra", count: f.num!, refs: [f.ref] }));

  const fStart = v.get("event.start");
  const fEnd = v.get("event.end");
  const fDur = v.get("event.duration_min");
  const startMin = toMin(fStart?.text ?? null);
  const endMin = toMin(fEnd?.text ?? null);
  let duration: number;
  if (startMin !== null && endMin !== null && endMin > startMin) duration = endMin - startMin;
  else if (fDur?.num) duration = fDur.num;
  else {
    duration = POLICY.defaultDurationMin;
    notes.push(`policy: duration ${duration} min (not stated)`);
  }
  if (startMin !== null && endMin !== null && fDur?.num && endMin - startMin !== fDur.num)
    notes.push(`start/end span ${endMin - startMin} min used over stated duration ${fDur.num} min`);
  const budgetTotal = v.num("event.budget_total");
  if (budgetTotal === null) problems.push("budget total not stated");

  // ---------- Judging ----------
  const confirmedFacts = v.each("judging.confirmed");
  const named = [...new Set(confirmedFacts.filter((f) => f.entity).map((f) => f.entity!))];
  const countFact = confirmedFacts.filter((f) => !f.entity && typeof f.num === "number").pop();
  const withdrawnFacts = v.each("judging.withdrawn");
  const withdrawnNames = withdrawnFacts.filter((f) => f.entity).map((f) => f.entity!);
  const withdrawnCount = withdrawnFacts.reduce((n, f) => n + (f.entity ? 1 : f.num ?? 0), 0);
  const confirmed = Math.max(named.length, countFact?.num ?? 0);
  const namedLeft = named.filter((n) => !withdrawnNames.some((w) => canon(w) === canon(n)));
  const available = Math.max(0, confirmed - withdrawnCount);
  const jpt = v.num("judging.judges_per_team") ?? POLICY.judgesPerTeam;
  const maxTpj = v.num("judging.max_teams_per_judge");
  const minPerTeam = v.num("judging.minutes_per_team");
  const feeFact = v.get("judging.fee");
  const fee = feeFact?.num ?? 0;
  const judgesNeeded = teams > 0 ? Math.max(jpt, maxTpj ? ceil((teams * jpt) / maxTpj) : jpt) : 0;
  const judgingRefs = refsOf(...confirmedFacts, ...withdrawnFacts, v.get("judging.judges_per_team"), v.get("judging.max_teams_per_judge"), v.get("judging.minutes_per_team"), feeFact);
  if (!confirmedFacts.length) problems.push("no confirmed judges stated");

  // ---------- Food presence ----------
  const tiers = v.each("food.price").filter((f) => typeof f.num === "number");
  const foodPlanned = tiers.length > 0;

  // ---------- Schedule (choose the fewest judges whose judging window fits) ----------
  // Build time always absorbs the remainder (policy), so a "build" block from a message is not a separate requirement.
  const requiredBlocks = v.each("schedule.block").filter((f) => ((f.num ?? 0) > 0 || f.text) && !isBuildLabel(f.entity));
  const forbids = v.each("schedule.forbid_window").map((f) => {
    const [a, b] = (f.text ?? "").split(/\s*(?:-|–|—|\bto\b|\btak\b)\s*/i);
    const s = toMin(a);
    const e = toMin(b);
    return s !== null && e !== null && startMin !== null ? { s: s - startMin, e: e - startMin, ref: f.ref, text: f.text } : null;
  }).filter(Boolean) as { s: number; e: number; ref: string; text: string | null }[];

  const loadFor = (used: number) => (used > 0 ? ceil((teams * jpt) / used) : teams);
  // Policy: judging block rounded up to 5 minutes (still ≥ the window needed).
  const windowFor = (used: number) => Math.ceil((minPerTeam ? loadFor(used) * minPerTeam : POLICY.lunchMin) / 5) * 5;
  if (!minPerTeam) notes.push(`policy: judging window ${POLICY.lunchMin} min (minutes per team not stated)`);

  const buildSchedule = (judgingWindow: number): { blocks: ScheduleBlock[]; ok: boolean; why: string } => {
    const placed: ScheduleBlock[] = [];
    const D = duration;
    const overlaps = (s: number, len: number) =>
      placed.some((b) => s < b.start + b.minutes && b.start < s + len) || forbids.some((w) => s < w.e && w.s < s + len);
    // A block is pinned to a clock time only if that time is visible in its own evidence (guards against invented times).
    const fixedAt = (f: Fact) => {
      if (startMin === null || !hasClock(f.evidence)) return null;
      const t = toMin(f.text);
      return t === null ? null : t - startMin;
    };

    // fixed-time required blocks first
    const flexible: Fact[] = [];
    for (const f of requiredBlocks) {
      const at = fixedAt(f);
      const len = f.num ?? 0;
      if (at !== null && len > 0) placed.push({ label: f.entity ?? "required block", kind: "required", start: at, minutes: len, fixed: f.text, refs: [f.ref], src: f.id });
      else flexible.push(f);
    }
    const isLabel = (f: Fact, re: RegExp) => re.test(canon(f.entity));
    const fixedOpening = flexible.find((f) => isLabel(f, /open|kick|welcome|brief/));
    const fixedClosing = flexible.find((f) => isLabel(f, /clos|award|prize|ceremon/));
    const fixedLunch = flexible.find((f) => isLabel(f, /lunch|meal|food/));
    const fixedJudging = flexible.find((f) => isLabel(f, /judg|present|demo|pitch/));
    const rest = flexible.filter((f) => ![fixedOpening, fixedClosing, fixedLunch, fixedJudging].includes(f));

    const openLen = fixedOpening?.num ?? POLICY.openingMin;
    const closeLen = fixedClosing?.num ?? POLICY.closingMin;
    const judgeLen = Math.max(judgingWindow, fixedJudging?.num ?? 0);
    const lunchLen = foodPlanned ? fixedLunch?.num ?? POLICY.lunchMin : 0;

    const put = (label: string, kind: ScheduleBlock["kind"], target: number, len: number, refs: string[], lo = 0, hi = D, src?: string) => {
      if (len <= 0) return true;
      for (let d = 0; d <= D; d += 5) {
        for (const s of d === 0 ? [target] : [target - d, target + d]) {
          if (s >= lo && s + len <= hi && !overlaps(s, len)) {
            placed.push({ label, kind, start: s, minutes: len, refs, src });
            return true;
          }
        }
      }
      return false;
    };
    if (!put("Opening", "opening", 0, openLen, refsOf(fixedOpening), 0, D, fixedOpening?.id)) return { blocks: placed, ok: false, why: "no slot for opening" };
    if (!put("Closing & results", "closing", D - closeLen, closeLen, refsOf(fixedClosing), 0, D, fixedClosing?.id)) return { blocks: placed, ok: false, why: "no slot for closing" };
    const closing = placed.find((b) => b.kind === "closing")!;
    if (!put("Judging", "judging", closing.start - judgeLen, judgeLen, refsOf(fixedJudging), openLen, closing.start, fixedJudging?.id))
      return { blocks: placed, ok: false, why: `judging window ${judgeLen} min does not fit before closing` };
    const judging = placed.find((b) => b.kind === "judging")!;
    if (lunchLen > 0) {
      const target = Math.round((openLen + (judging.start - openLen) / 2 - lunchLen / 2) / 5) * 5;
      if (!put("Lunch", "lunch", target, lunchLen, refsOf(fixedLunch), openLen, judging.start, fixedLunch?.id)) return { blocks: placed, ok: false, why: "no slot for lunch" };
    }
    for (const f of rest) {
      const len = f.num ?? 0;
      if (len <= 0) continue;
      const lunch = placed.find((b) => b.kind === "lunch");
      const anchor = lunch ? lunch.start + lunch.minutes : openLen;
      const target = Math.round((anchor + (judging.start - anchor) / 2) / 5) * 5;
      if (!put(f.entity ?? "required block", "required", target, len, [f.ref], openLen, judging.start, f.id))
        return { blocks: placed, ok: false, why: `no slot for required block ${f.entity ?? ""} (${len} min)` };
    }
    // build fills every gap
    placed.sort((a, b) => a.start - b.start);
    const blocks: ScheduleBlock[] = [];
    let cursor = 0;
    for (const b of placed) {
      if (b.start > cursor) blocks.push({ label: "Build / hacking", kind: "build", start: cursor, minutes: b.start - cursor, refs: [] });
      blocks.push(b);
      cursor = Math.max(cursor, b.start + b.minutes);
    }
    if (cursor < D) blocks.push({ label: "Build / hacking", kind: "build", start: cursor, minutes: D - cursor, refs: [] });
    const build = blocks.filter((b) => b.kind === "build").reduce((n, b) => n + b.minutes, 0);
    if (build < POLICY.minBuildMin) return { blocks, ok: false, why: `build time ${build} min < policy minimum ${POLICY.minBuildMin} min` };
    return { blocks, ok: true, why: "" };
  };

  let judgesUsed = opts.judgesUsedOverride ?? judgesNeeded;
  let sched = buildSchedule(windowFor(judgesUsed));
  if (!opts.judgesUsedOverride) {
    while (!sched.ok && /judging|build time/.test(sched.why) && judgesUsed < available) {
      judgesUsed++;
      sched = buildSchedule(windowFor(judgesUsed));
    }
    if (judgesUsed > judgesNeeded && sched.ok) notes.push(`judges used raised ${judgesNeeded} → ${judgesUsed} so the judging window fits the schedule`);
  }
  if (!sched.ok) problems.push(`schedule: ${sched.why}`);
  const load = loadFor(judgesUsed);
  const windowMin = windowFor(judgesUsed);

  const judgeNames = [...namedLeft];
  for (let i = judgeNames.length; i < judgesUsed; i++) judgeNames.push(`Judge ${i + 1}`);
  const usedNames = judgeNames.slice(0, judgesUsed);
  const assignments = Array.from({ length: teams }, (_, i) => ({
    team: `Team ${i + 1}`,
    judges: Array.from({ length: Math.min(jpt, usedNames.length) }, (_, k) => usedNames[(i * jpt + k) % Math.max(1, usedNames.length)]),
  }));

  // ---------- People ----------
  const extraTotal = extras.reduce((n, e) => n + e.count, 0);
  const peopleOnSite = participants + staff + judgesUsed + extraTotal;
  let feedExtra = 0;
  for (const f of v.each("feed.include").filter((x) => x.op !== "forbid")) {
    const g = canon(f.entity);
    if (/^(staff|participant|judge)/.test(g)) continue;
    const match = extras.find((e) => canon(e.group) === g || canon(e.group).includes(g) || g.includes(canon(e.group)));
    feedExtra += typeof f.num === "number" ? f.num : match?.count ?? 0;
    if (typeof f.num !== "number" && !match) problems.push(`feed.include ${f.entity}: group size not stated`);
  }
  const peopleToFeed = participants + staff + judgesUsed + feedExtra;

  // ---------- Venue ----------
  const hours = duration / 60;
  const optionNames = new Map<string, string>();
  for (const k of ["venue.capacity", "venue.price", "venue.attr", "venue.unavailable"])
    for (const f of v.each(k)) if (f.entity && !optionNames.has(canon(f.entity))) optionNames.set(canon(f.entity), f.entity);
  const required = [...new Set(v.each("venue.require_attr").flatMap(attrTokens))];
  const maxRooms = v.num("venue.max_rooms");
  const maxPerRoom = v.num("venue.max_per_room");
  const options = [...optionNames.entries()].map(([c, name]) => {
    const of = (k: string) => v.each(k).filter((f) => canon(f.entity) === c);
    const cap = of("venue.capacity").pop();
    const price = of("venue.price").pop();
    const unavailable = of("venue.unavailable").length > 0;
    const attrs = [...new Set([...of("venue.attr"), ...of("venue.capacity"), ...of("venue.price")].flatMap(attrTokens).filter((a) => a !== "per_hour" && a !== "hourly"))];
    // Hourly only when the price is explicitly per hour ("per hour", "/hr", "hourly", "fi ghanta"), never for "a 4-hour slot".
    const perHourText = /(per|\/|an|each|fi|har)\s*-?\s*(hour|hr|ghant)|hourly|ghanta\s*ka/i;
    const hourly = !!price && (price.basis === "per_hour" || price.attrs.some((a) => /^(per_)?hour(ly)?$|^per_hr$/i.test(a)) || perHourText.test(price.evidence)) && !/\b(day|event|flat|full|slot|package)\b/i.test(price.evidence);
    let cost = price?.num ?? 0;
    if (price && price.basis === "per_head") cost = (price.num ?? 0) * peopleOnSite;
    else if (hourly) cost = (price!.num ?? 0) * Math.ceil(hours);
    const capacity = cap?.num ?? 0;
    const usable = maxPerRoom ? Math.min(capacity, maxPerRoom) : capacity;
    return { name, capacity, usable, cost, attrs, unavailable, priced: !!price, hourly: !!hourly, refs: refsOf(cap, price, ...of("venue.attr"), ...of("venue.unavailable")) };
  });
  // Only filter on attributes the venue data talks about; an attribute no option mentions is an organiser action item.
  const checkable = required.filter((r) => options.some((o) => attrMatch(o.attrs, r)));
  const unverified = required.filter((r) => !checkable.includes(r));
  for (const r of unverified) notes.push(`venue requirement "${r}": no option lists it — organiser action item, not a venue filter`);
  const eligible = options.filter((o) => !o.unavailable && o.usable > 0 && checkable.every((r) => attrMatch(o.attrs, r)));
  let best: typeof eligible | null = null;
  let bestCost = Infinity;
  const n = Math.min(eligible.length, POLICY.maxVenueOptions);
  for (let mask = 1; mask < 1 << n; mask++) {
    const set = eligible.slice(0, n).filter((_, i) => mask & (1 << i));
    if (maxRooms && set.length > maxRooms) continue;
    const usable = set.reduce((s, o) => s + o.usable, 0);
    if (usable < peopleOnSite) continue;
    const cost = set.reduce((s, o) => s + o.cost, 0);
    const better =
      !best || cost < bestCost || (cost === bestCost && (set.length < best.length || (set.length === best.length && usable > best.reduce((s, o) => s + o.usable, 0))));
    if (better) {
      best = set;
      bestCost = cost;
    }
  }
  let venue: Plan["venue"] = null;
  if (best) {
    const cap = best.reduce((s, o) => s + o.usable, 0);
    venue = {
      rooms: best.map((o) => ({ name: o.name, capacity: o.usable, cost: o.cost, attrs: o.attrs, refs: o.refs })),
      capacity: cap,
      cost: bestCost,
      headroom: cap - peopleOnSite,
      required_attrs: checkable,
      unverified_attrs: unverified,
      reason: `cheapest ${best.length > 1 ? `${best.length}-room set` : "option"} with capacity ≥ ${peopleOnSite}${checkable.length ? ` and ${checkable.join(", ")}` : ""}${maxPerRoom ? `, ≤ ${maxPerRoom} per room` : ""} (${eligible.length} eligible of ${options.length})`,
    };
    for (const o of best) if (!o.priced) notes.push(`venue ${o.name}: no price stated, costed at 0`);
    for (const o of best) if (o.hourly) notes.push(`venue ${o.name}: hourly price × ${Math.ceil(hours)} h`);
  } else if (options.length) {
    const maxCap = eligible.reduce((s, o) => s + o.usable, 0);
    problems.push(`venue: no option set fits ${peopleOnSite} people${checkable.length ? ` with ${checkable.join(", ")}` : ""} (eligible capacity ${maxCap}, ${eligible.length}/${options.length} options eligible)`);
  } else problems.push("venue: no venue options stated");

  // ---------- Budget + food tier ----------
  const committed: LineItem[] = v.each("budget.committed").filter((f) => typeof f.num === "number").map((f) => ({ label: f.entity ?? "committed", amount: f.num!, refs: [f.ref] }));
  const approvals = v.each("budget.approve").filter((a) => a.op !== "forbid");
  const requests = v.each("budget.request").map((f) => {
    const approved = approvals.some((a) => canon(a.entity) === canon(f.entity) || (canon(a.entity).length > 0 && (canon(a.entity).includes(canon(f.entity)) || canon(f.entity).includes(canon(a.entity)))));
    return { f, approved };
  });
  const approvedItems: LineItem[] = requests.filter((r) => r.approved && typeof r.f.num === "number").map((r) => ({ label: `${r.f.entity ?? "request"} (approved)`, amount: r.f.num!, refs: [r.f.ref, ...refsOf(...approvals.filter((a) => canon(a.entity) === canon(r.f.entity)))] }));
  const honoraria = judgesUsed * fee;
  const fees = v.each("food.fee").filter((f) => typeof f.num === "number");
  const taxFact = v.get("budget.tax");
  const reserveFact = v.get("budget.reserve");
  const diets = v.each("food.require").filter((f) => typeof f.num === "number").map((f) => ({ diet: f.entity ?? "special", count: f.num!, refs: [f.ref] }));

  const costFood = (t: Fact) => {
    const price = t.num!;
    const base = t.basis === "fixed" ? price : price * peopleToFeed;
    const feeItems: LineItem[] = fees.map((f) => {
      const amt = isPct(f) ? Math.round((base * f.num!) / 100) : f.basis === "per_head" ? f.num! * peopleToFeed : f.num!;
      return { label: f.entity ?? "fee", amount: amt, refs: [f.ref] };
    });
    return { base, feeItems, total: base + feeItems.reduce((s, x) => s + x.amount, 0) };
  };
  const totalsWith = (foodTotal: number) => {
    const subtotal = committed.reduce((s, x) => s + x.amount, 0) + approvedItems.reduce((s, x) => s + x.amount, 0) + (venue?.cost ?? 0) + foodTotal + honoraria;
    const tax = taxFact ? (isPct(taxFact) ? Math.round((subtotal * (taxFact.num ?? 0)) / 100) : taxFact.num ?? 0) : 0;
    const reserve = reserveFact ? (isPct(reserveFact) ? Math.round(((budgetTotal ?? 0) * (reserveFact.num ?? 0)) / 100) : reserveFact.num ?? 0) : 0;
    return { subtotal, tax, reserve, total: subtotal + tax + reserve };
  };

  let food: Plan["food"] = null;
  let chosenFoodTotal = 0;
  if (foodPlanned) {
    const costed = tiers.map((t) => ({ t, c: costFood(t), tot: totalsWith(costFood(t).total).total }));
    const fits = (x: (typeof costed)[number]) => budgetTotal === null || x.tot <= budgetTotal;
    const standard = POLICY.standardTierLabels.map((l) => costed.find((x) => canon(x.t.entity).split(" ").includes(l))).find(Boolean);
    const byCost = [...costed].sort((a, b) => a.c.total - b.c.total);
    let pick = standard && fits(standard) ? standard : byCost.find(fits);
    let reason: string;
    if (standard && pick === standard) reason = `standard tier (plan total Rs ${pick.tot.toLocaleString()} within budget)`;
    else if (pick) reason = standard ? `standard tier would bring the plan to Rs ${standard.tot.toLocaleString()} > budget Rs ${budgetTotal?.toLocaleString()}; cheapest tier that fits` : `no tier labelled standard; cheapest tier that fits`;
    else {
      pick = byCost[0];
      reason = `no tier fits the budget; cheapest tier shown`;
      problems.push(`budget: cheapest plan Rs ${pick.tot.toLocaleString()} exceeds budget Rs ${budgetTotal?.toLocaleString()} by Rs ${(pick.tot - (budgetTotal ?? 0)).toLocaleString()}`);
    }
    chosenFoodTotal = pick.c.total;
    const diet = diets.reduce((s, d) => s + d.count, 0);
    if (diet > peopleToFeed) problems.push(`food: dietary counts ${diet} exceed people to feed ${peopleToFeed}`);
    food = {
      tier: pick.t.entity ?? "menu",
      price_per_head: pick.t.basis === "fixed" ? Math.round(pick.t.num! / Math.max(1, peopleToFeed)) : pick.t.num!,
      quantity: peopleToFeed,
      fees: pick.c.feeItems,
      diets,
      cost: pick.c.total,
      reason,
      refs: refsOf(pick.t, ...fees, ...v.each("food.require"), ...v.each("feed.include")),
    };
  } else problems.push("food: no food options stated");

  const t = totalsWith(chosenFoodTotal);
  const items: LineItem[] = [
    ...committed,
    ...approvedItems,
    ...(venue ? [{ label: `Venue: ${venue.rooms.map((r) => r.name).join(" + ")}`, amount: venue.cost, refs: venue.rooms.flatMap((r) => r.refs) }] : []),
    ...(food ? [{ label: `Food: ${food.tier} × ${food.quantity}`, amount: food.cost - food.fees.reduce((s, x) => s + x.amount, 0), refs: food.refs, detail: `Rs ${food.price_per_head} × ${food.quantity}` }, ...food.fees.map((f) => ({ ...f, label: `Food fee: ${f.label}` }))] : []),
    ...(fee > 0 ? [{ label: `Judge honoraria`, amount: honoraria, refs: refsOf(feeFact), detail: `${judgesUsed} × Rs ${fee}` }] : []),
  ];
  const budget: Plan["budget"] = {
    items,
    subtotal: t.subtotal,
    tax: t.tax,
    reserve: t.reserve,
    total: t.total,
    limit: budgetTotal,
    remaining: budgetTotal === null ? null : budgetTotal - t.total,
  };
  if (budgetTotal !== null && t.total > budgetTotal && !problems.some((p) => p.startsWith("budget:")))
    problems.push(`budget: total Rs ${t.total.toLocaleString()} exceeds budget Rs ${budgetTotal.toLocaleString()} by Rs ${(t.total - budgetTotal).toLocaleString()}`);

  const remainingForRequests = budget.remaining;
  const plan: Plan = {
    event: {
      participants,
      team_size: teamSize,
      teams,
      staff,
      extras,
      people_on_site: peopleOnSite,
      people_to_feed: peopleToFeed,
      duration_min: duration,
      start: fStart?.text ?? null,
      end: startMin !== null ? fmtClock(startMin, duration) : fEnd?.text ?? null,
      budget_total: budgetTotal,
      refs: {
        participants: refsOf(fParticipants),
        teams: refsOf(fTeams, v.get("event.team_size")),
        staff: refsOf(v.get("event.staff")),
        duration: refsOf(fStart, fEnd, fDur),
        budget_total: refsOf(v.get("event.budget_total")),
      },
    },
    venue,
    food,
    judging: confirmedFacts.length || teams
      ? {
          confirmed,
          withdrawn: withdrawnNames,
          available,
          judges_needed: judgesNeeded,
          judges_used: judgesUsed,
          judges_per_team: jpt,
          max_teams_per_judge: maxTpj ?? load,
          minutes_per_team: minPerTeam ?? 0,
          window_min: windowMin,
          fee,
          honoraria,
          assignments,
          judge_names: usedNames,
          refs: judgingRefs,
        }
      : null,
    schedule: { blocks: sched.blocks, total_min: duration, relative: startMin === null },
    budget,
    requests: requests.map(({ f, approved }) => ({
      ref: f.ref,
      label: f.entity ?? "request",
      amount: f.num,
      approved,
      affordable: approved || f.num === null || remainingForRequests === null ? null : remainingForRequests >= f.num,
    })),
    unencoded: [],
  };
  return { plan, problems, notes };
}
