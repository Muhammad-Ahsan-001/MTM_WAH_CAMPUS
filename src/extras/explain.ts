// "Explain this number": turns a figure on the dashboard into the formula (with the actual values) the solver
// used, the messages it came from, and the messages that once touched it but were overridden. Pure, zero tokens.
import type { SessionState } from "../core/types";

export type FigureKey =
  | "participants"
  | "teams"
  | "people_on_site"
  | "people_to_feed"
  | "duration"
  | "venue"
  | "food"
  | "judges"
  | "judging_window"
  | "honoraria"
  | "budget_total"
  | "remaining";

export interface Explanation {
  title: string;
  formula: string[];
  refs: string[];
  history: { ref: string; status: string; reason: string }[];
}

const rs = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `Rs ${n.toLocaleString("en-US")}`);
const uniq = (xs: (string | undefined | null)[]) => [...new Set(xs.filter((x): x is string => !!x))];

const KEYS: Record<FigureKey, RegExp> = {
  participants: /^event\.participants$/,
  teams: /^event\.(teams|team_size|participants)$/,
  people_on_site: /^(event\.(participants|staff)|people\.extra|judging\.)/,
  people_to_feed: /^(event\.(participants|staff)|feed\.include|people\.extra|judging\.)/,
  duration: /^(event\.(duration_min|start|end)|schedule\.)/,
  venue: /^venue\./,
  food: /^(food\.(price|fee|quantity|require)|feed\.include)/,
  judges: /^judging\./,
  judging_window: /^(judging\.|schedule\.)/,
  honoraria: /^judging\.(fee|confirmed|withdrawn)/,
  budget_total: /^event\.budget_total$/,
  remaining: /^(budget\.|event\.budget_total$)/,
};

const HISTORY_STATUSES = new Set(["superseded", "rejected", "needs_decision", "duplicate"]);

function historyFor(state: SessionState, key: FigureKey) {
  const re = KEYS[key];
  const out: Explanation["history"] = [];
  const seen = new Set<string>();
  for (const m of state.messages) {
    const touched = m.facts.filter((f) => re.test(f.key));
    if (!touched.length) continue;
    if (HISTORY_STATUSES.has(m.status) && !seen.has(m.ref)) {
      seen.add(m.ref);
      out.push({ ref: m.ref, status: m.status, reason: m.reason });
      continue;
    }
    for (const f of touched) {
      if ((f.status === "superseded" || f.status === "rejected") && !seen.has(f.id)) {
        seen.add(f.id);
        out.push({ ref: m.ref, status: f.status, reason: f.reason ?? `${f.key} ${f.num ?? f.text ?? ""}`.trim() });
      }
    }
  }
  return out;
}

export function explainFigure(state: SessionState, key: FigureKey): Explanation {
  const p = state.plan;
  const history = historyFor(state, key);
  if (!p) return { title: "No plan yet", formula: ["No plan has been computed for this session yet."], refs: [], history };
  const e = p.event;
  const j = p.judging;
  const extrasTotal = e.extras.reduce((n, x) => n + x.count, 0);
  const extrasStr = e.extras.length ? e.extras.map((x) => `${x.group} ${x.count}`).join(" + ") : "0";
  const fedExtra = e.people_to_feed - e.participants - e.staff - (j?.judges_used ?? 0);
  const ju = j?.judges_used ?? 0;
  let title = "";
  let formula: string[] = [];
  let refs: string[] = [];

  switch (key) {
    case "participants":
      title = `Participants: ${e.participants}`;
      formula = [`participants = ${e.participants} (stated in the messages)`];
      refs = e.refs.participants ?? [];
      break;
    case "teams":
      title = `Teams: ${e.teams}`;
      formula = e.team_size
        ? [`teams = ceil(participants / team_size) = ceil(${e.participants} / ${e.team_size}) = ${e.teams}`]
        : [`teams = ${e.teams} (team count stated directly)`];
      refs = uniq([...(e.refs.teams ?? []), ...(e.refs.participants ?? [])]);
      break;
    case "people_on_site":
      title = `People on site: ${e.people_on_site}`;
      formula = [
        `people_on_site = participants + staff + judges_used + extra groups`,
        `= ${e.participants} + ${e.staff} + ${ju} + ${extrasTotal}${e.extras.length ? ` (${extrasStr})` : ""} = ${e.people_on_site}`,
      ];
      refs = uniq([...(e.refs.participants ?? []), ...(e.refs.staff ?? []), ...(j?.refs ?? []), ...e.extras.flatMap((x) => x.refs)]);
      break;
    case "people_to_feed":
      title = `Meals to order: ${e.people_to_feed}`;
      formula = [
        `qty = participants + staff + judges_used (+ fed groups)`,
        `= ${e.participants} + ${e.staff} + ${ju}${fedExtra ? ` + ${fedExtra}` : ""} = ${e.people_to_feed}`,
      ];
      if (e.people_to_feed !== e.people_on_site) formula.push(`(people on site ${e.people_on_site}; only groups named in a feed.include message are fed)`);
      refs = uniq([...(e.refs.participants ?? []), ...(e.refs.staff ?? []), ...(j?.refs ?? []), ...(p.food?.refs ?? [])]);
      break;
    case "duration":
      title = `Duration: ${e.duration_min} min`;
      formula =
        e.start && e.end
          ? [`duration = end − start = ${e.end} − ${e.start} = ${e.duration_min} min`]
          : [`duration = ${e.duration_min} min${(e.refs.duration ?? []).length ? " (stated)" : " (policy default, not stated)"}`];
      refs = e.refs.duration ?? [];
      break;
    case "venue": {
      const v = p.venue;
      title = v ? `Venue: ${v.rooms.map((r) => r.name).join(" + ")}` : "Venue: no room fits";
      formula = v
        ? [
            `venue = cheapest set of rooms with capacity ≥ people on site (${e.people_on_site})`,
            ...v.rooms.map((r) => `  ${r.name}: capacity ${r.capacity}, cost ${rs(r.cost)}${r.attrs.length ? ` [${r.attrs.join(", ")}]` : ""}`),
            `capacity ${v.capacity} ≥ ${e.people_on_site} (headroom ${v.headroom}), cost ${rs(v.cost)}`,
            ...(v.required_attrs.length ? [`required: ${v.required_attrs.join(", ")}`] : []),
            ...(v.reason ? [v.reason] : []),
          ]
        : [`no room option has capacity ≥ ${e.people_on_site}`];
      refs = uniq(v?.rooms.flatMap((r) => r.refs) ?? []);
      break;
    }
    case "food": {
      const f = p.food;
      title = f ? `Food: ${f.tier} — ${rs(f.cost)}` : "Food: no options";
      if (f) {
        const feeSum = f.fees.reduce((s, x) => s + x.amount, 0);
        const base = f.cost - feeSum;
        formula = [
          `food = qty × price + fees = ${f.quantity} × ${rs(f.price_per_head)} + ${rs(feeSum)} = ${rs(f.cost)}`,
          ...(base !== f.quantity * f.price_per_head ? [`(fixed-price menu: base ${rs(base)})`] : []),
          ...f.fees.map((x) => `  fee ${x.label}: ${rs(x.amount)}`),
          `qty = participants + staff + judges_used (+ fed groups) = ${e.participants} + ${e.staff} + ${ju}${fedExtra ? ` + ${fedExtra}` : ""} = ${f.quantity}`,
          `tier: ${f.reason}`,
          ...(f.diets.length ? [`dietary: ${f.diets.map((d) => `${d.diet} ${d.count}`).join(", ")}`] : []),
        ];
      } else formula = ["no food price stated in any message"];
      refs = f?.refs ?? [];
      break;
    }
    case "judges":
      title = j ? `Judges: ${j.judges_used}` : "Judges";
      formula = j
        ? [
            `judges_needed = ceil(teams × judges_per_team / max_teams_per_judge) = ceil(${e.teams} × ${j.judges_per_team} / ${j.max_teams_per_judge}) = ${j.judges_needed}`,
            j.judges_used > j.judges_needed
              ? `judges_used raised ${j.judges_needed} → ${j.judges_used} so the judging window fits the schedule`
              : `judges_used = judges_needed = ${j.judges_used}`,
            `available = confirmed − withdrawn = ${j.confirmed} − ${j.confirmed - j.available} = ${j.available}${j.withdrawn.length ? ` (withdrawn: ${j.withdrawn.join(", ")})` : ""}`,
          ]
        : ["no judging stated"];
      refs = j?.refs ?? [];
      break;
    case "judging_window":
      title = j ? `Judging window: ${j.window_min} min` : "Judging window";
      formula = j
        ? j.minutes_per_team
          ? [
              `window = ceil(teams × jpt / judges_used) × minutes_per_team, rounded up to 5`,
              `= ceil(${e.teams} × ${j.judges_per_team} / ${j.judges_used}) × ${j.minutes_per_team} = ${Math.ceil((e.teams * j.judges_per_team) / Math.max(1, j.judges_used)) * j.minutes_per_team} → ${j.window_min} min`,
            ]
          : [`window = ${j.window_min} min (policy: minutes per team not stated)`]
        : ["no judging stated"];
      refs = j?.refs ?? [];
      break;
    case "honoraria":
      title = j ? `Judge honoraria: ${rs(j.honoraria)}` : "Judge honoraria";
      formula = j ? [`honoraria = judges_used × fee = ${j.judges_used} × ${rs(j.fee)} = ${rs(j.honoraria)}`] : ["no judging stated"];
      refs = j?.refs ?? [];
      break;
    case "budget_total":
    case "remaining": {
      const b = p.budget;
      title = key === "remaining" ? `Remaining: ${rs(b?.remaining)}` : `Budget total: ${rs(b?.total)}`;
      if (b) {
        formula = [
          `total = sum of line items + tax + reserve`,
          ...b.items.map((it) => `  ${it.label}: ${rs(it.amount)}${it.detail ? ` (${it.detail})` : ""}`),
          `= ${rs(b.subtotal)} + ${rs(b.tax)} + ${rs(b.reserve)} = ${rs(b.total)}`,
          `remaining = budget − total = ${rs(b.limit)} − ${rs(b.total)} = ${rs(b.remaining)}`,
        ];
        refs = uniq([...(e.refs.budget_total ?? []), ...b.items.flatMap((it) => it.refs)]);
      } else formula = ["no budget computed"];
      break;
    }
  }
  return { title, formula, refs, history };
}
