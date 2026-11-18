/**
 * Plan renderers: templates only (no model-written prose). Every figure lists the message refs it came from.
 */
import { seatingPlan } from "./jev/seating";
import { fmtClock, toMin } from "./jev/solve";
import { renderTraceFile } from "./trace";
import type { Plan, SessionState } from "./types";

const rs = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `Rs ${n.toLocaleString("en-US")}`);
const from = (refs: string[] | undefined) => (refs && refs.length ? ` _(from ${[...new Set(refs)].join(", ")})_` : "");

export function planMarkdown(state: SessionState): string {
  const plan = state.plan;
  const out: string[] = [];
  out.push(`# SceneBnao plan — session ${state.label || state.id.slice(0, 8)}`);
  const model = [...new Set(state.calls.map((c) => c.model).filter((m) => m !== "(no response)"))].join(", ");
  out.push(`Model: ${model || "—"} — declared as our small model (no official list, confirmed at help desk)`);
  out.push("");
  const six = state.checks.filter((c) => c.id !== "constraint");
  out.push(`**Checks:** ${six.map((c) => `${c.pass ? "✅" : "❌"} ${c.label}`).join(" · ")}`);
  out.push("");
  out.push(...aiCallsSection(state));
  if (!plan) return out.concat(["", "_No plan yet._"]).join("\n");
  out.push("");
  out.push(...changesSection(state));
  out.push(...eventSection(plan));
  out.push(...venueSection(plan));
  out.push(...scheduleSection(plan));
  out.push(...foodSection(plan));
  out.push(...judgingSection(plan));
  out.push(...seatingSection(plan));
  out.push(...budgetSection(plan));
  if (plan.unencoded.length) {
    out.push("## Constraints outside the DSL");
    for (const u of plan.unencoded) out.push(`- ${u.handled ? "✅" : "⚠️"} ${u.text} — ${u.note}${from([u.ref])}`);
    out.push("");
  }
  out.push("## Checks");
  for (const c of state.checks) out.push(`- ${c.pass ? "✅" : "❌"} **${c.label}** — ${c.detail}`);
  out.push("");
  out.push("## Messages");
  out.push("| Ref | Status | Role | Date | Reason |");
  out.push("|---|---|---|---|---|");
  for (const m of state.messages) out.push(`| ${m.ref} | ${m.status} | ${m.role} | ${m.date ?? "—"} | ${(m.reason || m.summary).replace(/\|/g, "/")} |`);
  const rejected = state.messages.filter((m) => m.status === "rejected" || m.status === "needs_decision");
  out.push("");
  out.push(`## Rejected / held (${rejected.length})`);
  for (const m of rejected) out.push(`- **${m.ref}** (${m.role}, ${m.date ?? "undated"}) — ${m.reason}`);
  return out.join("\n");
}

function eventSection(p: Plan): string[] {
  const e = p.event;
  return [
    "## Event",
    `- Participants: **${e.participants}**${from(e.refs.participants)} · Teams: **${e.teams}**${e.team_size ? ` (size ${e.team_size})` : ""}${from(e.refs.teams)} · Staff: ${e.staff}${from(e.refs.staff)}`,
    `- On site: **${e.people_on_site}** · To feed: **${e.people_to_feed}**${e.extras.length ? ` · Extra groups: ${e.extras.map((x) => `${x.group} ${x.count}`).join(", ")}` : ""}`,
    `- Duration: **${e.duration_min} min**${e.start ? ` (${e.start}–${e.end})` : ""}${from(e.refs.duration)} · Budget: **${rs(e.budget_total)}**${from(e.refs.budget_total)}`,
    "",
  ];
}
function venueSection(p: Plan): string[] {
  if (!p.venue) return ["## Venue", "_No feasible venue._", ""];
  return [
    "## Venue",
    ...p.venue.rooms.map((r) => `- **${r.name}** — capacity ${r.capacity}, ${rs(r.cost)}${r.attrs.length ? `, ${r.attrs.join(", ")}` : ""}${from(r.refs)}`),
    `- Total capacity ${p.venue.capacity} for ${p.event.people_on_site} on site (headroom ${p.venue.headroom}). Why: ${p.venue.reason}`,
    "",
  ];
}
function scheduleSection(p: Plan): string[] {
  if (!p.schedule) return ["## Schedule", "_No schedule._", ""];
  const s0 = toMin(p.event.start);
  return [
    "## Schedule",
    "| Time | Block | Minutes |",
    "|---|---|---|",
    ...p.schedule.blocks.map((b) => `| ${fmtClock(s0, b.start)}–${fmtClock(s0, b.start + b.minutes)} | ${b.label}${from(b.refs)} | ${b.minutes} |`),
    `Total ${p.schedule.blocks.reduce((s, b) => s + b.minutes, 0)} / ${p.event.duration_min} min.`,
    "",
  ];
}
function foodSection(p: Plan): string[] {
  if (!p.food) return ["## Food", "_No food plan._", ""];
  const f = p.food;
  return [
    "## Food",
    `- Tier **${f.tier}** at ${rs(f.price_per_head)}/head × **${f.quantity}** = ${rs(f.price_per_head * f.quantity)}${from(f.refs)}`,
    ...f.fees.map((x) => `- ${x.label}: ${rs(x.amount)}${from(x.refs)}`),
    ...(f.diets.length ? [`- Dietary: ${f.diets.map((d) => `${d.count} ${d.diet}`).join(", ")} (within ${f.quantity})`] : []),
    `- Food total ${rs(f.cost)}. Why: ${f.reason}`,
    "",
  ];
}
function judgingSection(p: Plan): string[] {
  if (!p.judging) return ["## Judging", "_No judging plan._", ""];
  const j = p.judging;
  return [
    "## Judging",
    `- Judges: **${j.judges_used}** used / ${j.judges_needed} needed / ${j.available} available (${j.confirmed} confirmed${j.withdrawn.length ? `, withdrawn: ${j.withdrawn.join(", ")}` : ""})${from(j.refs)}`,
    `- ${j.judges_per_team} judge(s) per team, max ${j.max_teams_per_judge} teams per judge, ${j.minutes_per_team} min per team → window ${j.window_min} min; honoraria ${rs(j.honoraria)}`,
    "",
    "| Team | Judges |",
    "|---|---|",
    ...j.assignments.map((a) => `| ${a.team} | ${a.judges.join(", ")} |`),
    "",
  ];
}
const cell = (s: string) => String(s ?? "—").replace(/\|/g, "/").replace(/\n/g, " ");

function changesSection(state: SessionState): string[] {
  const updates = state.batches.slice(1);
  if (!updates.length) return ["## Changes", "No updates yet — this is the first plan.", ""];
  const lines = ["## Changes"];
  for (const b of updates) {
    const msgs = state.messages.filter((m) => m.batch === b.batch);
    lines.push(`### Batch ${b.batch} — \`${b.file}\`${from(b.message_refs)}`);
    for (const m of msgs) lines.push(`- **${m.ref}** — ${m.status}: ${cell(m.reason || m.summary)}`);
    if (!msgs.length) lines.push("- No messages in this batch.");
    lines.push(`- Model calls: ${b.areas_called.length ? b.areas_called.join(", ") : "none"} · Recomputed by code (0 tokens): ${b.areas_recomputed.length ? b.areas_recomputed.join(", ") : "nothing"}`);
    if (b.error) lines.push(`- ⚠️ ${cell(b.error)}`);
    if (b.diff.length) {
      lines.push("", "| Figure | Before | After |", "|---|---|---|", ...b.diff.map((d) => `| ${cell(d.path)} | ${cell(d.old)} | ${cell(d.new)} |`));
    } else lines.push("- No figure changed.");
    lines.push("");
  }
  return lines;
}
function seatingSection(p: Plan): string[] {
  const s = seatingPlan(p);
  const lines = ["## Seating plan"];
  if (!s.rooms.length) lines.push("_No seating plan._");
  for (const r of s.rooms) {
    lines.push(`### ${r.name}`, "| Table | Team | Seats | Judge(s) |", "|---|---|---|---|");
    for (const t of r.tables) lines.push(`| ${t.table} | ${t.team} | ${t.seats} | ${t.judges.length ? t.judges.join(", ") : "—"} |`);
    if (!r.tables.length) lines.push("| — | — | 0 | — |");
    const parts = [`${r.participants} at ${r.tables.length} table${r.tables.length === 1 ? "" : "s"}`];
    if (r.desk) parts.push(`${r.desk.staff} staff at the ${r.desk.label.toLowerCase()}`);
    if (r.judges.length) parts.push(`${r.judges.length} judge${r.judges.length === 1 ? "" : "s"} (${r.judges.join(", ")})`);
    lines.push(`- Seated **${r.seated}** / ${r.capacity} capacity — ${parts.join(" + ")}${from(r.refs)}`, "");
  }
  if (s.unseated.length) {
    lines.push("### Unseated teams", "| Team | Seats | Judge(s) |", "|---|---|---|");
    for (const t of s.unseated) lines.push(`| ${t.team} | ${t.seats} | ${t.judges.length ? t.judges.join(", ") : "—"} |`);
    lines.push("");
  }
  for (const n of s.notes) lines.push(`- Note: ${n}`);
  if (s.notes.length || !s.rooms.length) lines.push("");
  return lines;
}
/** One line per AI call (number, exact model name from the API response, purpose, tokens as reported) plus a total. */
const PURPOSE: Record<string, string> = {
  reading: "reading messages",
  venue: "venue (constraint fallback)",
  schedule: "schedule (constraint fallback)",
  food: "food (constraint fallback)",
  judging: "judging (constraint fallback)",
  budget: "budget (constraint fallback)",
};
function aiCallsSection(state: SessionState): string[] {
  const calls = [...state.calls].sort((a, b) => a.seq - b.seq);
  const lines = ["## AI calls (trace summary)", ""];
  if (!calls.length) return [...lines, "_No AI calls yet._", ""];
  lines.push("| Call | Model (from API response) | What it was for | Tokens (prompt + completion = total) |", "|---|---|---|---|");
  const t = { p: 0, c: 0, tot: 0, r: 0 };
  for (const c of calls) {
    const u = c.usage;
    if (u) {
      t.p += u.prompt_tokens ?? 0;
      t.c += u.completion_tokens ?? 0;
      t.tot += u.total_tokens ?? 0;
      t.r += u.reasoning_tokens ?? 0;
    }
    const tok = u ? `${u.prompt_tokens.toLocaleString("en-US")} + ${u.completion_tokens.toLocaleString("en-US")} = **${u.total_tokens.toLocaleString("en-US")}**${u.reasoning_tokens ? ` (incl. ${u.reasoning_tokens.toLocaleString("en-US")} reasoning)` : ""}` : "no usage returned";
    lines.push(`| #${c.seq} | ${c.model} | ${PURPOSE[c.area] ?? c.area} (batch ${c.batch}${c.error ? `, error: ${c.error.replace(/\|/g, "/")}` : ""}) | ${tok} |`);
  }
  lines.push(`| **Total** | ${calls.length} call${calls.length === 1 ? "" : "s"} | | ${t.p.toLocaleString("en-US")} + ${t.c.toLocaleString("en-US")} = **${t.tot.toLocaleString("en-US")}**${t.r ? ` (incl. ${t.r.toLocaleString("en-US")} reasoning)` : ""} |`, "");
  lines.push("Token counts are copied exactly from each API response's `usage` object; the full input and raw output of every call are in the Trace section.", "");
  return lines;
}

function budgetSection(p: Plan): string[] {
  if (!p.budget) return ["## Budget", "_No budget._", ""];
  const b = p.budget;
  const lines = ["## Budget", "| Item | Amount |", "|---|---|", ...b.items.map((i) => `| ${i.label}${i.detail ? ` (${i.detail})` : ""}${from(i.refs)} | ${rs(i.amount)} |`)];
  if (b.tax) lines.push(`| Tax | ${rs(b.tax)} |`);
  if (b.reserve) lines.push(`| Reserve | ${rs(b.reserve)} |`);
  lines.push(`| **Total** | **${rs(b.total)}** |`, `| Budget | ${rs(b.limit)} |`, `| Remaining | ${rs(b.remaining)} |`, "");
  if (b.limit !== null) lines.push(`**Fits the budget: ${b.total <= b.limit ? "YES" : "NO"}** — ${rs(b.total)} against ${rs(b.limit)} (${b.total <= b.limit ? `${rs(b.remaining)} left` : `${rs(-(b.remaining ?? 0))} over`}).`, "");
  if (p.requests.length) {
    lines.push("### Requests (not committed unless approved)");
    for (const r of p.requests) lines.push(`- ${r.label}: ${rs(r.amount)} — ${r.approved ? "approved, committed" : `affordable: ${r.affordable === null ? "n/a" : r.affordable ? "yes" : "no"} (remaining ${rs(b.remaining)})`}${from([r.ref])}`);
    lines.push("");
  }
  return lines;
}

export function finalMarkdown(state: SessionState): string {
  return `${planMarkdown(state)}\n\n## Trace\n\n\`\`\`\n${renderTraceFile(state)}\n\`\`\`\n`;
}

export function planJson(state: SessionState) {
  return {
    session: { id: state.id, label: state.label, version: state.plan_version },
    models: [...new Set(state.calls.map((c) => c.model))],
    plan: state.plan,
    checks: state.checks,
    messages: state.messages.map((m) => ({ ref: m.ref, batch: m.batch, sender: m.sender, role: m.role, date: m.date, status: m.status, reason: m.reason, summary: m.summary })),
    batches: state.batches,
  };
}
