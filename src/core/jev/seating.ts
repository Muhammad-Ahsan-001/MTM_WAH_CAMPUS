/**
 * Seating plan: rooms → globally numbered tables (T1..Tn) → team, seats, judge(s).
 * Deterministic code only (0 tokens). Every figure comes from the Plan at runtime; layout choices are POLICY.seating.
 * Never mutates the plan passed in, and never silently drops a team (teams that fit nowhere are listed as unseated).
 */
import { POLICY } from "../policy";
import type { Plan } from "../types";

export interface SeatingTable {
  /** Global table label, e.g. "T3". */
  table: string;
  number: number;
  /** Team label, exactly as in plan.judging.assignments[].team when a judging plan exists. */
  team: string;
  /** Participant seats at this table (the team's size). */
  seats: number;
  judges: string[];
}

export interface SeatingRoom {
  name: string;
  capacity: number;
  tables: SeatingTable[];
  /** Participants seated at team tables in this room. */
  participants: number;
  /** Staff/registration desk (POLICY.seating.staffDeskPerRoom), or null if this room has none. */
  desk: { label: string; staff: number } | null;
  /** Judges counted toward this room's capacity (POLICY: the room of their first assigned team). */
  judges: string[];
  /** Everyone counted in this room: table seats + desk staff + judges. */
  seated: number;
  free: number;
  refs: string[];
}

export interface Seating {
  rooms: SeatingRoom[];
  /** Teams that fit in no room — kept here, never dropped. */
  unseated: { team: string; seats: number; judges: string[] }[];
  totals: { teams: number; tables: number; participants: number; seated: number; capacity: number };
  notes: string[];
}

/** Largest-remainder split of `total` into integers proportional to `weights` (ties → bigger weight, then earlier). */
function apportion(total: number, weights: number[]): number[] {
  const n = weights.length;
  if (!n || total <= 0) return weights.map(() => 0);
  const w = weights.map((x) => Math.max(0, x));
  const sum = w.reduce((s, x) => s + x, 0);
  if (sum <= 0) return apportion(total, weights.map(() => 1));
  const exact = w.map((x) => (x / sum) * total);
  const out = exact.map((x) => Math.floor(x));
  let left = total - out.reduce((s, x) => s + x, 0);
  const order = exact
    .map((x, i) => ({ i, r: x - Math.floor(x) }))
    .sort((a, b) => b.r - a.r || w[b.i] - w[a.i] || a.i - b.i);
  for (let k = 0; left > 0; k = (k + 1) % n, left--) out[order[k].i]++;
  return out;
}

/** Staff per room. POLICY: one desk per room, at least one staff each while staff last; the rest by capacity. */
function staffPerRoom(staff: number, caps: number[]): number[] {
  const n = caps.length;
  const out = caps.map(() => 0);
  if (!n || staff <= 0) return out;
  const bySize = caps.map((_, i) => i).sort((a, b) => caps[b] - caps[a] || a - b);
  if (!POLICY.seating.staffDeskPerRoom) {
    out[bySize[0]] = staff; // POLICY: a single desk, in the largest room
    return out;
  }
  if (staff < n) {
    for (let k = 0; k < staff; k++) out[bySize[k]] = 1;
    return out;
  }
  return apportion(staff - n, caps).map((x) => x + 1);
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function seatingPlan(plan: Plan): Seating {
  const S = POLICY.seating;
  const e = plan.event;
  const notes: string[] = [];
  const P = Math.max(0, e.participants || 0);
  const assignments = plan.judging?.assignments ?? [];

  // ---- teams: labels from the judging plan, else "Team 1..N" ----
  let n = Math.max(e.teams || 0, assignments.length);
  if (n === 0 && P > 0) {
    const size = e.team_size || S.seatsPerTableDefault;
    n = Math.ceil(P / size);
    notes.push(`No team count stated — assumed ${plural(n, "team")} of up to ${size} from ${P} participants${e.team_size ? "" : " (policy default table size)"}.`);
  }
  const labels = assignments.map((a) => a.team);
  for (let k = 1; labels.length < n; k++) {
    const l = `${S.teamLabelPrefix}${k}`;
    if (!labels.includes(l)) labels.push(l);
  }
  const judgesOf = new Map<string, string[]>();
  for (const a of assignments) judgesOf.set(a.team, [...(judgesOf.get(a.team) ?? []), ...a.judges]);

  // ---- seats per team: spread participants so the total equals the participant count ----
  let seats: number[];
  if (P > 0 && n > 0) {
    const base = Math.floor(P / n);
    const extra = P % n;
    seats = labels.map((_, i) => base + (i < extra ? 1 : 0));
    if (extra > 0) notes.push(`${plural(extra, "team")} of ${base + 1} and ${plural(n - extra, "team")} of ${base}, so seats add up to ${P} participants.`);
    if (e.team_size && P !== n * e.team_size) notes.push(`Participants (${P}) ≠ teams × team size (${n} × ${e.team_size}); table seats follow the participant count.`);
    if (base === 0) notes.push(`Fewer participants (${P}) than teams (${n}) — some tables have no seats.`);
  } else {
    const size = e.team_size || S.seatsPerTableDefault;
    seats = labels.map(() => size);
    if (n > 0) notes.push(`No participant count stated — ${size} seats per table${e.team_size ? " (stated team size)" : " (policy default)"}.`);
  }
  const teams = labels.map((team, i) => ({ team, seats: seats[i], judges: [...(judgesOf.get(team) ?? [])] }));
  const tableSeats = (t: { seats: number; judges: string[] }) => t.seats + (S.judgesTakeTableSeats ? t.judges.length : 0);

  const empty = (note: string): Seating => ({
    rooms: [],
    unseated: [],
    totals: { teams: n, tables: 0, participants: 0, seated: 0, capacity: 0 },
    notes: [note, ...notes],
  });
  if (!plan.venue) return empty(`No venue chosen — ${plural(n, "team")} (${P} participants) cannot be seated yet.`);
  if (!plan.venue.rooms.length) return empty(`The chosen venue lists no rooms — ${plural(n, "team")} (${P} participants) cannot be seated yet.`);

  // ---- rooms: desk staff reserved first, then teams proportional to the remaining capacity ----
  const rooms = plan.venue.rooms;
  const caps = rooms.map((r) => Math.max(0, r.capacity || 0));
  const staff = Math.max(0, e.staff || 0);
  const desk = staffPerRoom(staff, caps);
  const load = [...desk];
  rooms.forEach((r, i) => {
    if (desk[i] > caps[i]) notes.push(`${r.name}: desk staff (${desk[i]}) exceed its capacity (${caps[i]}).`);
  });
  const target = apportion(n, caps.map((c, i) => c - desk[i]));
  const pref: number[] = [];
  target.forEach((k, r) => {
    for (let x = 0; x < k; x++) pref.push(r);
  });

  const home = new Map<string, number>(); // judge → room counted in (POLICY: room of first assigned team)
  const roomJudges: string[][] = rooms.map(() => []);
  const placed: number[][] = rooms.map(() => []);
  const unseated: Seating["unseated"] = [];
  let moved = 0;
  let unseatedNeed = 0;
  teams.forEach((t, i) => {
    const newJudges = S.judgesTakeTableSeats ? [] : [...new Set(t.judges)].filter((j) => !home.has(j));
    const need = tableSeats(t) + newJudges.length;
    const fits = (r: number) => load[r] + need <= caps[r];
    let r = pref[i] ?? 0;
    if (!fits(r)) {
      const alt = caps
        .map((_, k) => k)
        .filter(fits)
        .sort((a, b) => caps[b] - load[b] - (caps[a] - load[a]) || a - b);
      if (!alt.length) {
        unseated.push({ team: t.team, seats: t.seats, judges: [...t.judges] });
        unseatedNeed += need;
        return;
      }
      r = alt[0];
      moved++;
    }
    placed[r].push(i);
    load[r] += need;
    for (const j of newJudges) {
      home.set(j, r);
      roomJudges[r].push(j);
    }
  });
  if (moved) notes.push(`${plural(moved, "team")} placed outside their capacity-proportional room because it was full.`);
  if (unseated.length) {
    const spare = caps.reduce((s, c, k) => s + Math.max(0, c - load[k]), 0);
    notes.push(
      `${plural(unseated.length, "team")} fit in no room: ${unseated.map((t) => `${t.team} (${t.seats})`).join(", ")} — ` +
        `${unseatedNeed} places needed, ${spare} spare (${Math.max(0, unseatedNeed - spare)}+ more capacity needed); listed as unseated, not dropped.`,
    );
  }

  // Judges with no seated team still need a place: the room with the most free space.
  if (!S.judgesTakeTableSeats) {
    for (const j of plan.judging?.judge_names ?? []) {
      if (home.has(j)) continue;
      const r = caps.map((_, k) => k).sort((a, b) => caps[b] - load[b] - (caps[a] - load[a]) || a - b)[0];
      if (caps[r] - load[r] >= 1) {
        home.set(j, r);
        roomJudges[r].push(j);
        load[r] += 1;
      } else notes.push(`${j} has no seated team and no room has a free place.`);
    }
  }

  // ---- number tables globally in room order ----
  let no = 0;
  const out: SeatingRoom[] = rooms.map((room, r) => {
    const tables = placed[r].map((i) => {
      no++;
      return { table: `${S.tablePrefix}${no}`, number: no, team: teams[i].team, seats: teams[i].seats, judges: [...teams[i].judges] };
    });
    const hasDesk = S.staffDeskPerRoom || desk[r] > 0;
    return {
      name: room.name,
      capacity: caps[r],
      tables,
      participants: tables.reduce((s, t) => s + t.seats, 0),
      desk: hasDesk ? { label: S.deskLabel, staff: desk[r] } : null,
      judges: [...roomJudges[r]],
      seated: load[r],
      free: caps[r] - load[r],
      refs: [...room.refs],
    };
  });

  const unstaffed = out.filter((r) => r.desk && r.desk.staff === 0).map((r) => r.name);
  if (unstaffed.length) notes.push(`${staff === 0 ? "No staff stated" : `Only ${plural(staff, "staff member")} for ${plural(rooms.length, "room")}`} — desk unstaffed in ${unstaffed.join(", ")}.`);

  // Other people on site (beyond participants, staff and judges) get no table: check they fit in the spare places.
  const judgesCounted = home.size;
  const others = (e.people_on_site || 0) - P - staff - (S.judgesTakeTableSeats ? (plan.judging?.judges_used ?? 0) : judgesCounted);
  const free = out.reduce((s, r) => s + Math.max(0, r.free), 0);
  if (others > 0) {
    const groups = e.extras.length ? ` (${e.extras.map((x) => `${x.group} ${x.count}`).join(", ")})` : "";
    notes.push(
      free >= others
        ? `${plural(others, "other person", "other people")} on site${groups} have no team table; ${free} spare places cover them.`
        : `${plural(others, "other person", "other people")} on site${groups} have no team table and only ${free} spare places remain — ${others - free} short.`,
    );
  }

  return {
    rooms: out,
    unseated,
    totals: {
      teams: n,
      tables: no,
      participants: out.reduce((s, r) => s + r.participants, 0),
      seated: out.reduce((s, r) => s + r.seated, 0),
      capacity: caps.reduce((s, c) => s + c, 0),
    },
    notes,
  };
}
