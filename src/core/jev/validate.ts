/**
 * Jev validate: the six scored checks (each with numbers) plus one line per hard constraint from the messages.
 * Everything is recomputed from the plan and the facts; nothing is trusted from the solver blindly.
 */
import { canon } from "../facts";
import { POLICY } from "../policy";
import type { Check, Fact, Plan } from "../types";
import { hasClock, isBuildLabel, toMin } from "./solve";

const rs = (n: number | null | undefined) => (n === null || n === undefined ? "?" : `Rs ${n.toLocaleString("en-US")}`);

export function validate(plan: Plan, facts: Fact[], problems: string[]): Check[] {
  const active = facts.filter((f) => f.status === "active");
  const checks: Check[] = [];
  const e = plan.event;

  // 1. figures consistent
  {
    const errs: string[] = [];
    const extras = e.extras.reduce((s, x) => s + x.count, 0);
    const judgesUsed = plan.judging?.judges_used ?? 0;
    if (e.people_on_site !== e.participants + e.staff + judgesUsed + extras)
      errs.push(`people on site ${e.people_on_site} ≠ ${e.participants}+${e.staff}+${judgesUsed}+${extras}`);
    if (e.team_size && !active.some((f) => f.key === "event.teams") && e.teams !== Math.ceil(e.participants / e.team_size))
      errs.push(`teams ${e.teams} ≠ ceil(${e.participants}/${e.team_size})`);
    if (plan.food && plan.food.quantity !== e.people_to_feed) errs.push(`food quantity ${plan.food.quantity} ≠ people to feed ${e.people_to_feed}`);
    if (plan.venue && plan.venue.capacity !== plan.venue.rooms.reduce((s, r) => s + r.capacity, 0)) errs.push("venue capacity ≠ sum of rooms");
    if (plan.budget) {
      const sum = plan.budget.items.reduce((s, i) => s + i.amount, 0);
      if (sum !== plan.budget.subtotal) errs.push(`line items ${rs(sum)} ≠ subtotal ${rs(plan.budget.subtotal)}`);
      if (plan.budget.subtotal + plan.budget.tax + plan.budget.reserve !== plan.budget.total) errs.push("subtotal + tax + reserve ≠ total");
    }
    if (plan.judging && plan.judging.honoraria !== plan.judging.judges_used * plan.judging.fee) errs.push("honoraria ≠ judges × fee");
    if (plan.schedule) {
      const sum = plan.schedule.blocks.reduce((s, b) => s + b.minutes, 0);
      if (sum !== e.duration_min) errs.push(`schedule sums to ${sum} ≠ ${e.duration_min} min`);
    }
    checks.push({
      id: "figures",
      label: "figures consistent",
      pass: errs.length === 0 && e.participants > 0 && e.teams > 0,
      detail: errs.length ? errs.join("; ") : `${e.participants} participants, ${e.teams} teams, ${e.people_on_site} on site, ${e.people_to_feed} fed; totals recomputed`,
    });
  }

  // 2. within budget
  {
    const b = plan.budget;
    const pass = !!b && b.limit !== null && b.total <= b.limit;
    checks.push({
      id: "budget",
      label: "within budget",
      pass,
      detail: !b || b.limit === null ? "no budget total stated" : `total ${rs(b.total)} ≤ budget ${rs(b.limit)} (remaining ${rs(b.remaining)})${pass ? "" : " — OVER"}`,
    });
  }

  // 3. venue fits
  {
    const v = plan.venue;
    const errs: string[] = [];
    if (!v) errs.push(problems.find((p) => p.startsWith("venue")) ?? "no venue chosen");
    else {
      if (v.capacity < e.people_on_site) errs.push(`capacity ${v.capacity} < ${e.people_on_site}`);
      const maxPerRoom = active.filter((f) => f.key === "venue.max_per_room").pop()?.num;
      const maxRooms = active.filter((f) => f.key === "venue.max_rooms").pop()?.num;
      if (maxRooms && v.rooms.length > maxRooms) errs.push(`${v.rooms.length} rooms > max ${maxRooms}`);
      for (const r of v.rooms) {
        if (maxPerRoom && r.capacity > maxPerRoom) errs.push(`${r.name} ${r.capacity} > max per room ${maxPerRoom}`);
        if (active.some((f) => f.key === "venue.unavailable" && f.op !== "remove" && f.op !== "forbid" && canon(f.entity) === canon(r.name))) errs.push(`${r.name} is unavailable`);
      }
    }
    checks.push({
      id: "venue",
      label: "venue fits",
      pass: errs.length === 0,
      detail: errs.length ? errs.join("; ") : `${v!.rooms.map((r) => `${r.name} (${r.capacity})`).join(" + ")} = ${v!.capacity} ≥ ${e.people_on_site} on site${v!.required_attrs.length ? `; has ${v!.required_attrs.join(", ")}` : ""}`,
    });
  }

  // 4. schedule valid
  {
    const s = plan.schedule;
    const errs: string[] = [];
    if (!s || !s.blocks.length) errs.push(problems.find((p) => p.startsWith("schedule")) ?? "no schedule");
    else {
      const blocks = [...s.blocks].sort((a, b) => a.start - b.start);
      const sum = blocks.reduce((n, b) => n + b.minutes, 0);
      if (sum !== e.duration_min) errs.push(`blocks sum ${sum} ≠ duration ${e.duration_min}`);
      for (let i = 1; i < blocks.length; i++)
        if (blocks[i].start < blocks[i - 1].start + blocks[i - 1].minutes) errs.push(`overlap: ${blocks[i - 1].label} / ${blocks[i].label}`);
      if (blocks[0].start !== 0) errs.push("schedule does not start at event start");
      const j = blocks.find((b) => b.kind === "judging");
      const need = plan.judging && plan.judging.minutes_per_team ? Math.ceil((e.teams * plan.judging.judges_per_team) / Math.max(1, plan.judging.judges_used)) * plan.judging.minutes_per_team : 0;
      if (!j) errs.push("no judging block");
      else if (j.minutes < need) errs.push(`judging ${j.minutes} min < needed ${need} min`);
      if (plan.food && !blocks.some((b) => b.kind === "lunch")) errs.push("food planned but no meal block");
      const build = blocks.filter((b) => b.kind === "build").reduce((n, b) => n + b.minutes, 0);
      if (build < POLICY.minBuildMin) errs.push(`build ${build} min < ${POLICY.minBuildMin}`);
      const startMin = toMin(e.start);
      for (const f of active.filter((x) => x.key === "schedule.block" && x.op !== "remove" && !isBuildLabel(x.entity))) {
        const b = blocks.find((x) => x.src === f.id);
        if (!b) errs.push(`required block "${f.entity}" missing`);
        else {
          if ((f.num ?? 0) > b.minutes) errs.push(`"${f.entity}" ${b.minutes} min < required ${f.num}`);
          const t = hasClock(f.evidence) ? toMin(f.text) : null;
          if (t !== null && startMin !== null && b.start !== t - startMin) errs.push(`"${f.entity}" not at fixed time ${f.text}`);
        }
      }
      if (startMin !== null)
        for (const f of active.filter((x) => x.key === "schedule.forbid_window")) {
          const [a, c] = (f.text ?? "").split(/\s*(?:-|–|—|\bto\b|\btak\b)\s*/i).map(toMin);
          if (a === null || c === null || a === undefined || c === undefined) continue;
          const hit = blocks.find((b) => b.kind !== "build" && b.start < c - startMin && a - startMin < b.start + b.minutes);
          if (hit) errs.push(`${hit.label} overlaps forbidden window ${f.text}`);
        }
    }
    checks.push({
      id: "schedule",
      label: "schedule valid",
      pass: errs.length === 0,
      detail: errs.length ? errs.join("; ") : `${s!.blocks.length} blocks sum to ${e.duration_min} min; judging ${s!.blocks.find((b) => b.kind === "judging")?.minutes} min; no overlaps`,
    });
  }

  // 5. enough judges
  {
    const j = plan.judging;
    const errs: string[] = [];
    if (!j) errs.push("no judging data");
    else {
      if (j.judges_needed > j.available) errs.push(`need ${j.judges_needed} judges, only ${j.available} available (${j.confirmed} confirmed − ${j.confirmed - j.available} withdrawn)`);
      if (j.judges_used > j.available) errs.push(`using ${j.judges_used} > available ${j.available}`);
      const load = new Map<string, number>();
      for (const a of j.assignments) {
        if (new Set(a.judges).size < j.judges_per_team) errs.push(`${a.team} has ${new Set(a.judges).size} judges < ${j.judges_per_team}`);
        for (const x of a.judges) load.set(x, (load.get(x) ?? 0) + 1);
      }
      const maxLoad = Math.max(0, ...load.values());
      const cap = active.filter((f) => f.key === "judging.max_teams_per_judge").pop()?.num;
      if (cap && maxLoad > cap) errs.push(`a judge has ${maxLoad} teams > max ${cap}`);
      if (j.assignments.length !== e.teams) errs.push("not every team assigned");
    }
    checks.push({
      id: "judges",
      label: "enough judges",
      pass: errs.length === 0,
      detail: errs.length ? errs.join("; ") : `${j!.judges_used} used ≥ ${j!.judges_needed} needed of ${j!.available} available; ${j!.judges_per_team}/team`,
    });
  }

  // 6. all five areas present
  {
    const missing = [
      !plan.venue && "venue",
      !(plan.schedule && plan.schedule.blocks.length) && "schedule",
      !plan.food && "food",
      !(plan.judging && plan.judging.assignments.length) && "judging",
      !(plan.budget && plan.budget.items.length) && "budget",
    ].filter(Boolean);
    checks.push({ id: "areas", label: "all areas covered", pass: missing.length === 0, detail: missing.length ? `missing: ${missing.join(", ")}` : "venue, schedule, food, judging, budget" });
  }

  // Hard constraints from messages (one line each)
  for (const f of active) {
    if (f.key === "venue.require_attr" && f.op !== "remove") {
      const want = [...f.attrs, f.text ?? "", f.entity ?? ""].map((a) => canon(a).replace(/\s+/g, "_")).filter(Boolean);
      const label = `${f.ref}: venue requires ${f.text ?? f.entity ?? f.attrs.join(",")}`;
      if (!plan.venue) checks.push({ id: "constraint", label, pass: false, detail: "no room satisfies it" });
      else if (want.some((w) => plan.venue!.unverified_attrs.includes(w)) && !want.some((w) => plan.venue!.required_attrs.includes(w)))
        checks.push({ id: "constraint", label, pass: false, advisory: true, detail: "no venue option lists this — organiser action item (arrange/verify on site)" });
      else checks.push({ id: "constraint", label, pass: true, detail: `${plan.venue.rooms.map((r) => r.name).join(" + ")} ha${plan.venue.rooms.length > 1 ? "ve" : "s"} it` });
    } else if (f.key === "venue.max_per_room" && plan.venue) {
      const ok = plan.venue.rooms.every((r) => r.capacity <= (f.num ?? Infinity));
      checks.push({ id: "constraint", label: `${f.ref}: max ${f.num} per room`, pass: ok, detail: plan.venue.rooms.map((r) => `${r.name} ${r.capacity}`).join(", ") });
    } else if (f.key === "food.require" && plan.food) {
      const ok = (f.num ?? 0) <= plan.food.quantity;
      checks.push({ id: "constraint", label: `${f.ref}: ${f.num} ${f.entity ?? "special"} meals`, pass: ok, detail: `${f.num} of ${plan.food.quantity} meals` });
    } else if (f.key === "food.quantity" && plan.food) {
      const ok = (f.num ?? 0) >= plan.food.quantity;
      checks.push({ id: "constraint", label: `${f.ref}: supplier quantity ${f.num}`, pass: ok, detail: `${f.num} ${ok ? "≥" : "<"} required ${plan.food.quantity}` });
    } else if (f.key === "schedule.block" && f.op !== "remove" && !isBuildLabel(f.entity)) {
      const ok = !!plan.schedule?.blocks.some((b) => b.src === f.id);
      checks.push({ id: "constraint", label: `${f.ref}: required block "${f.entity}"${f.num ? ` ${f.num} min` : ""}${f.text ? ` at ${f.text}` : ""}`, pass: ok, detail: ok ? "scheduled" : "missing" });
    } else if (f.key === "custom") {
      const u = plan.unencoded.find((x) => x.ref === f.ref && x.text === (f.text ?? ""));
      checks.push({ id: "constraint", label: `${f.ref}: ${f.text}`, pass: !!u?.handled, advisory: true, detail: u?.note ?? "not expressible in the DSL; area fallback pending" });
    }
  }
  return checks;
}

/** A plan is valid when the six scored checks and every machine-checkable constraint pass. */
export function isValid(checks: Check[]): boolean {
  return checks.every((c) => c.pass || c.advisory);
}

export function failedSummary(checks: Check[]): string {
  return checks
    .filter((c) => !c.pass && !c.advisory)
    .map((c) => `${c.label}: ${c.detail}`)
    .join("; ");
}
