/**
 * Event Kit group messages: pure templates, plan -> string. Zero model calls, zero tokens.
 * Every value comes from the current plan or from organiser inputs (form link, location) kept in the browser.
 */
import { fmtClock, toMin } from "../core/jev/solve";
import type { BatchInfo, Plan, PlanDiffEntry, ScheduleBlock, SessionState } from "../core/types";

export type Lang = "en" | "ur" | "both";

export interface KitInputs {
  formLink: string;
  location: string;
  lang: Lang;
  deadline: string; // blank = derived from the plan (start of judging)
}

export const EMPTY_INPUTS: KitInputs = { formLink: "", location: "", lang: "en", deadline: "" };

/** One team's seat, as written by the seating planner to localStorage `kit:<sid>:seating` (shape tolerated loosely). */
export interface SeatTeam {
  id: string;
  name: string;
  size: number;
  members: string[];
  table: number | null;
  room: string | null;
}

const rs = (n: number) => `Rs ${Math.round(n).toLocaleString("en-US")}`;
const nice = (s: string) => s.replace(/_/g, " ").replace(/\s+/g, " ").trim();

export function startMin(plan: Plan): number | null {
  return toMin(plan.event.start);
}
export function clock(plan: Plan, offset: number): string {
  return fmtClock(startMin(plan), offset);
}
function blocks(plan: Plan): ScheduleBlock[] {
  return plan.schedule?.blocks ?? [];
}
function block(plan: Plan, kind: ScheduleBlock["kind"]): ScheduleBlock | undefined {
  return blocks(plan).find((b) => b.kind === kind);
}
function span(plan: Plan, b: ScheduleBlock): string {
  return `${clock(plan, b.start)}–${clock(plan, b.start + b.minutes)}`;
}
function relNote(plan: Plan): string | null {
  return startMin(plan) === null ? "(T+ = time from event start; start time not fixed yet)" : null;
}
function relNoteUr(plan: Plan): string | null {
  return startMin(plan) === null ? "(T+ = event start se time; start time abhi fix nahi hua)" : null;
}
const lines = (...xs: (string | null | undefined | false)[]) => xs.filter((x): x is string => typeof x === "string").join("\n");

function both(lang: Lang, en: string, ur: string): string {
  if (lang === "en") return en;
  if (lang === "ur") return ur;
  return `${en}\n\n— — —\n\n${ur}`;
}

/** Default repo-submission deadline: the build-end time = start of the judging block. */
export function defaultDeadline(plan: Plan): string {
  const j = block(plan, "judging");
  return j ? clock(plan, j.start) : "";
}

// ---------- 1. Schedule ----------
export function scheduleMsg(plan: Plan, lang: Lang): string {
  const bs = blocks(plan);
  if (!bs.length) return both(lang, "Schedule: not fixed yet.", "Schedule abhi fix nahi hua.");
  const tl = bs.map((b) => `• ${span(plan, b)}  ${nice(b.label)}`).join("\n");
  const en = lines("*Event schedule*", "", tl, "", relNote(plan), "Please be on time for each slot!");
  const ur = lines("Assalam o Alaikum sab! 👋", "*Event ka schedule:*", "", tl, "", relNoteUr(plan), "Har slot pe time pe pohanchna, shukriya!");
  return both(lang, en, ur);
}

// ---------- 2. Venue & seating ----------
export function venueMsg(plan: Plan, lang: Lang, location: string, seats: SeatTeam[] | null): string {
  const rooms = plan.venue?.rooms ?? [];
  const roomTxt = rooms.length ? rooms.map((r) => r.name).join(", ") : "to be confirmed";
  const loc = location.trim();
  const seated = (seats ?? []).filter((s) => s.table !== null);
  const tableLines = seated.length
    ? seated
        .slice()
        .sort((a, b) => (a.room ?? "").localeCompare(b.room ?? "") || (a.table ?? 0) - (b.table ?? 0))
        .map((s) => `• ${s.id} ${s.name !== s.id ? s.name + " " : ""}→ Table ${s.table}${s.room && rooms.length > 1 ? ` (${s.room})` : ""}`)
        .join("\n")
    : null;
  const en = lines(
    "*Venue*",
    `Room: ${roomTxt}`,
    loc ? `Location: ${loc}` : null,
    `Teams: ${plan.event.teams}${plan.event.team_size ? ` (up to ${plan.event.team_size} per team)` : ""}`,
    tableLines ? "\n*Your table*\n" + tableLines : null,
    tableLines ? "Find your table number and sit with your team." : null,
  );
  const ur = lines(
    "Assalam o Alaikum sab!",
    `*Venue:* ${roomTxt}`,
    loc ? `Location: ${loc}` : null,
    `Total teams: ${plan.event.teams}`,
    tableLines ? "\n*Apni table dekh lein:*\n" + tableLines : null,
    tableLines ? "Apni team ke saath apni table pe baithein." : null,
  );
  return both(lang, en, ur);
}

// ---------- 3. Lunch ----------
export function lunchMsg(plan: Plan, lang: Lang): string {
  const l = block(plan, "lunch");
  const f = plan.food;
  const when = l ? span(plan, l) : "time to be confirmed";
  const diets = (f?.diets ?? []).filter((d) => d.count > 0);
  const dietTxt = diets.length ? diets.map((d) => `${nice(d.diet)}: ${d.count}`).join(", ") : null;
  const regular = f && diets.length ? Math.max(0, f.quantity - diets.reduce((a, d) => a + d.count, 0)) : null;
  const en = lines(
    "*Lunch*",
    `Time: ${when}`,
    f ? `Menu: ${nice(f.tier)} — ${f.quantity} portions` : null,
    dietTxt ? `Dietary: ${dietTxt}${regular !== null ? `, regular: ${regular}` : ""}` : null,
    dietTxt ? "If you asked for a special meal, tell the food desk your name." : null,
    relNote(plan),
  );
  const ur = lines(
    "Lunch time! 🍱",
    `Time: ${when}`,
    f ? `Khana: ${nice(f.tier)} — ${f.quantity} portions` : null,
    dietTxt ? `Special diet: ${dietTxt}` : null,
    dietTxt ? "Special meal wale food desk pe apna naam batayein." : null,
    relNoteUr(plan),
  );
  return both(lang, en, ur);
}

// ---------- 4. Judging ----------
export function judgingMsg(plan: Plan, lang: Lang): string {
  const j = plan.judging;
  const b = block(plan, "judging");
  const when = b ? span(plan, b) : "time to be confirmed";
  const en = lines(
    "*Judging guidelines*",
    `Window: ${when}`,
    j ? `• ${j.minutes_per_team} min per team` : null,
    j ? `• ${j.judges_per_team} judge${j.judges_per_team === 1 ? "" : "s"} per team` : null,
    "• All team members stay at the table during judging",
    "• Keep your demo ready before the window starts",
    relNote(plan),
  );
  const ur = lines(
    "Judging ka time aa raha hai!",
    `Time: ${when}`,
    j ? `• Har team ko ${j.minutes_per_team} minute milenge` : null,
    j ? `• Har team ke paas ${j.judges_per_team} judge aayenge` : null,
    "• Team ke saare members table pe hi rahein",
    "• Demo pehle se ready rakhein",
    relNoteUr(plan),
  );
  return both(lang, en, ur);
}

// ---------- 5. Repo submission ----------
export function repoMsg(plan: Plan, lang: Lang, formLink: string, deadline: string): string {
  const d = deadline.trim() || defaultDeadline(plan) || "before judging starts";
  const link = formLink.trim();
  const en = lines(
    "*Repo submission*",
    link ? `Submit your repo here: ${link}` : "Submission form link: (coming soon)",
    `Deadline: ${d} (end of build time)`,
    "One submission per team, please.",
  );
  const ur = lines(
    "Repo submit karna na bhoolein!",
    link ? `Form: ${link}` : "Form ka link jald share hoga.",
    `Deadline: ${d} (build time khatam hone se pehle)`,
    "Har team sirf ek submission kare.",
  );
  return both(lang, en, ur);
}

// ---------- 6. Budget / ops (organisers only) ----------
export function budgetMsg(plan: Plan): string {
  const b = plan.budget;
  if (!b) return "Budget: not computed yet (organizers only).";
  return lines(
    "*Budget / ops summary — organizers only*",
    "",
    ...b.items.map((i) => `• ${nice(i.label)}: ${rs(i.amount)}${i.detail ? ` (${i.detail})` : ""}`),
    b.tax ? `• Tax: ${rs(b.tax)}` : null,
    b.reserve ? `• Reserve: ${rs(b.reserve)}` : null,
    "",
    `Total: ${rs(b.total)}`,
    b.limit !== null ? `Limit: ${rs(b.limit)}` : null,
    b.remaining !== null ? `Remaining: ${rs(b.remaining)}` : null,
    `People on site: ${plan.event.people_on_site} · to feed: ${plan.event.people_to_feed}`,
  );
}

// ---------- Update broadcast from a batch diff ----------
export interface Broadcast {
  batch: number;
  text: string | null; // null when not broadcast
  blocked: string | null; // "Not broadcast: m<x> was rejected — <reason>"
}

function sentence(plan: Plan, d: PlanDiffEntry, latest: boolean, lang: "en" | "ur"): string | null {
  const ur = lang === "ur";
  const p = d.path;
  const v = d.new;
  if (v === "—" || v === "") return null;
  if (p === "schedule.blocks") {
    // diff strings read "Opening 15, Build / hacking 70, Lunch 30, …": rebuild offsets and report only what moved
    const parse = (s: string) => {
      let at = 0;
      const out: { label: string; start: number; minutes: number }[] = [];
      for (const part of s.split(/,\s*/)) {
        const m = /^(.*\S)\s+(\d+)$/.exec(part.trim());
        if (!m) return null;
        out.push({ label: m[1], start: at, minutes: Number(m[2]) });
        at += Number(m[2]);
      }
      return out.length ? out : null;
    };
    const o = parse(d.old);
    const n = parse(v);
    if (o && n) {
      const moved: string[] = [];
      const find = (xs: typeof n, re: RegExp) => xs.find((x) => re.test(x.label));
      for (const [re, en, urn] of [
        [/lunch/i, "Lunch", "Lunch"],
        [/judg/i, "Judging", "Judging"],
        [/clos/i, "Closing", "Closing"],
      ] as const) {
        const a = find(o, re);
        const b = find(n, re);
        if (b && (!a || a.start !== b.start || a.minutes !== b.minutes)) {
          const t = `${clock(plan, b.start)}–${clock(plan, b.start + b.minutes)}`;
          moved.push(ur ? `${urn} ab ${t} hoga` : `${en} moves to ${t}`);
        }
      }
      const added = n.filter((x) => !o.some((y) => y.label === x.label)).map((x) => nice(x.label));
      if (added.length) moved.push(ur ? `Naya slot: ${added.join(", ")}` : `New slot: ${added.join(", ")}`);
      if (moved.length) return moved.join("; ");
    }
    if (!latest) return ur ? `Schedule update hua: ${v}` : `Schedule updated: ${v}`;
    const l = block(plan, "lunch");
    const j = block(plan, "judging");
    const out = [
      l ? (ur ? `Lunch ab ${span(plan, l)} hoga` : `Lunch is now ${span(plan, l)}`) : null,
      j ? (ur ? `Judging ${span(plan, j)}` : `Judging is ${span(plan, j)}`) : null,
    ].filter(Boolean);
    return out.length ? out.join(ur ? "; " : "; ") : ur ? "Schedule update hua" : "Schedule updated";
  }
  if (p === "venue.rooms") return ur ? `Venue badal gaya: ab ${v}` : `Venue change: we are now in ${v}`;
  if (p === "judging.window_min") return ur ? `Judging window ab ${v} minute ki hai` : `Judging window is now ${v} min`;
  if (p === "judging.minutes_per_team") return ur ? `Har team ko ab ${v} minute milenge` : `Each team now gets ${v} min with judges`;
  if (p === "judging.judges_per_team") return ur ? `Har team ke paas ab ${v} judge` : `Now ${v} judge(s) per team`;
  if (p === "food.tier") return ur ? `Lunch menu ab: ${nice(v)}` : `Lunch menu is now ${nice(v)}`;
  if (p === "food.quantity") return ur ? `Lunch ${v} logon ke liye` : `Lunch ordered for ${v} people`;
  if (p === "food.diets") return ur ? `Special diet update: ${nice(v)}` : `Dietary meals updated: ${nice(v)}`;
  if (p === "event.start") return ur ? `Event ab ${v} baje shuru hoga` : `Event now starts at ${v}`;
  if (p === "event.end") return ur ? `Event ${v} pe khatam hoga` : `Event now ends at ${v}`;
  if (p === "event.duration_min") return ur ? `Event ki duration ab ${v} minute` : `Event length is now ${v} min`;
  if (p === "event.teams") return ur ? `Total teams ab ${v}` : `We now have ${v} teams`;
  if (p === "event.team_size") return ur ? `Team size ab ${v}` : `Team size is now ${v}`;
  if (p === "event.participants") return ur ? `Participants ab ${v}` : `Participants now ${v}`;
  return null; // budget/cost/internal paths are not for the group
}

export function broadcastFor(state: SessionState, b: BatchInfo, lang: Lang): Broadcast {
  const plan = state.plan;
  const latest = b.batch === Math.max(...state.batches.map((x) => x.batch));
  const msgs = state.messages.filter((m) => b.message_refs.includes(m.ref) || m.batch === b.batch);
  const applied = msgs.filter((m) => m.status === "applied");
  const held = msgs.filter((m) => m.status === "rejected" || m.status === "needs_decision");
  const mk = (l: "en" | "ur") => (plan ? b.diff.map((d) => sentence(plan, d, latest, l)).filter((s): s is string => !!s) : []);
  const en = mk("en");
  const ur = mk("ur");
  if (!en.length) {
    if (held.length) {
      const h = held[0];
      const verb = h.status === "rejected" ? "was rejected" : "is held for a decision";
      return { batch: b.batch, text: null, blocked: `Not broadcast: ${h.ref} ${verb} — ${h.reason}` };
    }
    return { batch: b.batch, text: null, blocked: applied.length ? "Nothing for the group: no participant-facing change." : "Nothing for the group: no plan change." };
  }
  const enTxt = lines("*Update*", ...en.map((s) => `• ${s}`), plan ? relNote(plan) : null);
  const urTxt = lines("*Update* — Assalam o Alaikum sab!", ...ur.map((s) => `• ${s}`), plan ? relNoteUr(plan) : null);
  return { batch: b.batch, text: both(lang, enTxt, urTxt), blocked: null };
}

/** Broadcasts for every batch after the first, newest first. */
export function broadcasts(state: SessionState, lang: Lang): Broadcast[] {
  return state.batches
    .filter((b) => b.batch > 1)
    .sort((a, b) => b.batch - a.batch)
    .map((b) => broadcastFor(state, b, lang));
}

export const waLink = (text: string) => `https://wa.me/?text=${encodeURIComponent(text)}`;

// ---------- Teams (seating roster or plan-derived) ----------
function num(x: unknown): number | null {
  const n = typeof x === "number" ? x : typeof x === "string" && x.trim() !== "" ? Number(x) : NaN;
  return Number.isFinite(n) ? n : null;
}
function str(x: unknown): string | null {
  return typeof x === "string" && x.trim() ? x.trim() : typeof x === "number" ? String(x) : null;
}

/** Parse whatever the seating planner stored; tolerate absence and unknown shapes. */
export function parseSeating(raw: unknown): SeatTeam[] | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const list = (Array.isArray(raw) ? raw : o.roster ?? o.teams ?? o.allocation ?? o.seats ?? o.assignments) as unknown;
  if (!Array.isArray(list) || !list.length) return null;
  const tableOf = new Map<string, { table: number | null; room: string | null }>();
  const alloc = Array.isArray(o.allocation) ? o.allocation : Array.isArray(o.tables) ? o.tables : null;
  if (alloc && alloc !== list)
    for (const a of alloc as Record<string, unknown>[]) {
      const id = str(a?.team ?? a?.teamId ?? a?.id);
      if (id) tableOf.set(id, { table: num(a.table ?? a.tableNo ?? a.number), room: str(a.room) });
    }
  const out: SeatTeam[] = [];
  list.forEach((t: unknown, i: number) => {
    if (!t || typeof t !== "object") return;
    const r = t as Record<string, unknown>;
    const id = str(r.id ?? r.teamId ?? r.team) ?? `T${String(i + 1).padStart(2, "0")}`;
    const members = Array.isArray(r.members) ? (r.members as unknown[]).map((m) => str(typeof m === "object" && m ? (m as Record<string, unknown>).name : m) ?? "").filter(Boolean) : [];
    const size = num(r.size) ?? (members.length || 0);
    const t2 = tableOf.get(id) ?? tableOf.get(str(r.name ?? r.teamName) ?? "");
    out.push({
      id,
      name: str(r.name ?? r.teamName) ?? id,
      size,
      members,
      table: num(r.table ?? r.tableNo) ?? t2?.table ?? null,
      room: str(r.room) ?? t2?.room ?? null,
    });
  });
  return out.length ? out : null;
}

/** Teams from the plan: plan.event.teams, size = team_size, remainder spread as smaller teams. */
export function planTeams(plan: Plan): SeatTeam[] {
  const n = Math.max(0, plan.event.teams);
  const p = plan.event.participants;
  const size = plan.event.team_size ?? (n ? Math.ceil(p / n) : 0);
  const room = plan.venue?.rooms[0]?.name ?? null;
  let left = p;
  const out: SeatTeam[] = [];
  for (let i = 0; i < n; i++) {
    const remainingTeams = n - i;
    const s = Math.max(1, Math.min(size, left - (remainingTeams - 1)));
    left -= s;
    out.push({ id: `T${String(i + 1).padStart(2, "0")}`, name: `Team ${i + 1}`, size: s, members: [], table: null, room });
  }
  return out;
}
