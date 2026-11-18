"use client";

import { createClient } from "@supabase/supabase-js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { seatingPlan } from "../../src/core/jev/seating";
import { fmtClock, toMin } from "../../src/core/jev/solve";
import { finalMarkdown } from "../../src/core/render";
import type { CallRecord } from "../../src/core/llm";
import type { Check, Message, Plan, SessionState } from "../../src/core/types";

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);

type SessionRow = { id: string; label: string; source: "cli" | "web"; updated_at: string };
type Tab = "overview" | "messages" | "plan" | "trace";

// ---------- vocabulary shown to people (plain language) ----------
const CHECK_TEXT: Record<string, string> = {
  figures: "Numbers add up",
  budget: "Within budget",
  venue: "Venue fits everyone",
  schedule: "Schedule works",
  judges: "Enough judges",
  areas: "All 5 areas planned",
};
const STATUS: Record<string, { label: string; meaning: string; chip: string; row: string }> = {
  applied: { label: "Used", meaning: "Its facts are used in the plan", chip: "bg-emerald-100 text-emerald-800 border-emerald-300", row: "" },
  superseded: { label: "Replaced", meaning: "A newer message changed this value", chip: "bg-amber-100 text-amber-800 border-amber-300", row: "" },
  irrelevant: { label: "Info only", meaning: "Not about the plan, or information with no effect on it",chip: "bg-slate-100 text-slate-600 border-slate-300", row: "text-slate-500" },
  request: { label: "Request", meaning: "Asks for money — listed, not committed until approved", chip: "bg-sky-100 text-sky-800 border-sky-300", row: "" },
  rejected: { label: "Rejected", meaning: "Not trusted — the reason is shown", chip: "bg-red-600 text-white border-red-700", row: "bg-red-50" },
  duplicate: { label: "Duplicate", meaning: "Repeat of an earlier message — not counted twice", chip: "bg-slate-100 text-slate-600 border-slate-300", row: "text-slate-500" },
  needs_decision: { label: "Held", meaning: "Would break the plan — kept out, needs a human decision", chip: "bg-orange-500 text-white border-orange-600", row: "bg-orange-50" },
};
const AREA_COLOR: Record<string, string> = {
  reading: "bg-indigo-600",
  venue: "bg-violet-600",
  schedule: "bg-sky-600",
  food: "bg-orange-600",
  judging: "bg-emerald-600",
  budget: "bg-rose-600",
};
const BLOCK_COLOR: Record<string, string> = {
  opening: "bg-indigo-500",
  build: "bg-slate-300",
  lunch: "bg-orange-400",
  judging: "bg-emerald-500",
  closing: "bg-violet-500",
  required: "bg-amber-400",
};
const rs = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `Rs ${n.toLocaleString("en-US")}`);

// ---------- small building blocks ----------
function From({ refs }: { refs?: string[] }) {
  const r = [...new Set(refs ?? [])];
  if (!r.length) return null;
  return (
    <span title={`Taken from message${r.length > 1 ? "s" : ""} ${r.join(", ")}`} className="ml-2 inline-block rounded border border-slate-200 bg-slate-50 px-1.5 text-[11px] font-medium text-slate-500">
      from {r.join(", ")}
    </span>
  );
}
function Box({ title, hint, children, className = "" }: { title: string; hint?: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border border-slate-200 bg-white p-5 shadow-sm ${className}`}>
      <h2 className="text-base font-bold text-slate-900">{title}</h2>
      {hint && <p className="mb-3 text-xs text-slate-500">{hint}</p>}
      {!hint && <div className="mb-3" />}
      {children}
    </section>
  );
}
function StatusChip({ status }: { status: string }) {
  const s = STATUS[status] ?? STATUS.applied;
  return <span className={`inline-block whitespace-nowrap rounded-md border px-2 py-0.5 text-xs font-bold ${s.chip}`}>{s.label}</span>;
}
function AreaTag({ a }: { a: string }) {
  return <span className={`mr-1 inline-block rounded px-1.5 py-0.5 text-[11px] font-bold text-white ${AREA_COLOR[a] ?? "bg-slate-500"}`}>{a}</span>;
}

export default function Dashboard() {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [sid, setSid] = useState<string | null>(null);
  const [state, setState] = useState<SessionState | null>(null);
  const [source, setSource] = useState<"cli" | "web">("web");
  const [tab, setTab] = useState<Tab>("overview");
  const [loading, setLoading] = useState(true);

  const loadSessions = useCallback(async () => {
    const { data } = await supabase.from("sessions").select("id,label,source,updated_at").order("updated_at", { ascending: false }).limit(50);
    const rows = (data as SessionRow[]) ?? [];
    setSessions(rows);
    return rows;
  }, []);
  const loadState = useCallback(async (id: string) => {
    const { data } = await supabase.from("sessions").select("state,source").eq("id", id).maybeSingle();
    if (data) {
      setState(data.state as SessionState);
      setSource(data.source);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadSessions().then((rows) => {
      if (rows[0]) setSid((cur) => cur ?? rows[0].id);
      else setLoading(false);
    });
    const ch = supabase
      .channel("sessions-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "sessions" }, (payload) => {
        loadSessions();
        const row = payload.new as { id?: string; state?: SessionState; source?: "cli" | "web" };
        setSid((cur) => {
          if (row?.id && row.id === cur && row.state) {
            setState(row.state);
            if (row.source) setSource(row.source);
          }
          return cur;
        });
      })
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [loadSessions]);
  useEffect(() => {
    if (sid) loadState(sid);
  }, [sid, loadState]);

  const calls = state?.calls ?? [];
  const tokens = useMemo(() => {
    const t = { prompt: 0, completion: 0, total: 0, reasoning: 0 };
    for (const c of calls) {
      if (!c.usage) continue;
      t.prompt += c.usage.prompt_tokens;
      t.completion += c.usage.completion_tokens;
      t.total += c.usage.total_tokens;
      t.reasoning += c.usage.reasoning_tokens ?? 0;
    }
    return t;
  }, [calls]);
  const models = [...new Set(calls.map((c) => c.model).filter((m) => m !== "(no response)"))];
  const six = (state?.checks ?? []).filter((c) => c.id !== "constraint");
  const messages = state?.messages ?? [];
  const rejected = messages.filter((m) => m.status === "rejected" || m.status === "needs_decision");

  function download() {
    if (!state) return;
    const blob = new Blob([finalMarkdown(state)], { type: "text/markdown" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "final-plan-and-trace.md";
    a.click();
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      {/* ---------- top bar ---------- */}
      <header className="mb-5 flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-2xl font-black tracking-tight text-slate-900">SceneBnao</h1>
          <p className="text-sm text-slate-500">Hackathon plan built from messages — the model only reads; our code (Jev) decides and checks everything.</p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <label className="text-xs font-semibold text-slate-500" htmlFor="session">
            Session
          </label>
          <select id="session" className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm" value={sid ?? ""} onChange={(e) => setSid(e.target.value)}>
            {sessions.length === 0 && <option value="">No sessions yet</option>}
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.source === "cli" ? "CLI · " : "Web · "}
                {s.label || s.id.slice(0, 8)}
              </option>
            ))}
          </select>
          <button onClick={download} disabled={!state} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold hover:bg-slate-100 disabled:opacity-40">
            Download plan + trace (.md)
          </button>
          <a href="/report" className="rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-700">
            Open readable report
          </a>
        </div>
      </header>
      <p className="mb-4 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm text-indigo-900">
        <b>Model:</b> {models.join(", ") || "—"} — declared as our small model (no official list, confirmed at help desk)
        {source === "cli" && <span className="ml-2 rounded bg-amber-200 px-2 py-0.5 text-xs font-bold text-amber-900">CLI session · updates live · read-only here</span>}
      </p>

      {loading ? (
        <p className="text-slate-500">Loading…</p>
      ) : !state ? (
        <Box title="No plan yet">
          <p className="text-sm text-slate-600">Paste a message pack below to start, or run <code className="rounded bg-slate-100 px-1">npx tsx plan.ts &lt;file&gt;</code> on the CLI.</p>
          <div className="mt-4">
            <AddMessage sid={null} readOnly={false} onDone={async (id) => (await loadSessions(), setSid(id), loadState(id))} />
          </div>
        </Box>
      ) : (
        <>
          <Verdict state={state} six={six} rejected={rejected.length} tokens={tokens.total} calls={calls.length} />
          <ChecksGrid six={six} />

          {/* ---------- tabs ---------- */}
          <nav className="mb-4 mt-6 flex flex-wrap gap-1 border-b border-slate-200">
            {(
              [
                ["overview", "Overview"],
                ["messages", `Messages (${messages.length})`],
                ["plan", "Plan details"],
                ["trace", `Trace · ${calls.length} model call${calls.length === 1 ? "" : "s"}`],
              ] as [Tab, string][]
            ).map(([k, label]) => (
              <button key={k} onClick={() => setTab(k)} className={`-mb-px rounded-t-lg border px-4 py-2 text-sm font-semibold ${tab === k ? "border-slate-200 border-b-white bg-white text-slate-900" : "border-transparent text-slate-500 hover:text-slate-800"}`}>
                {label}
              </button>
            ))}
          </nav>

          {tab === "overview" && (
            <div className="grid gap-4 lg:grid-cols-3">
              <div className="space-y-4 lg:col-span-2">
                {state.plan && <AtAGlance plan={state.plan} />}
                <LatestChange state={state} />
              </div>
              <div className="space-y-4">
                <RejectedBox rejected={rejected} />
                {state.plan && state.plan.requests.length > 0 && <RequestsBox plan={state.plan} />}
                <Box title="Add a message" hint="Paste one new message (or a whole pack) — same engine as the CLI.">
                  <AddMessage sid={sid} readOnly={source === "cli"} onDone={async (id) => (await loadSessions(), setSid(id), loadState(id))} />
                </Box>
              </div>
            </div>
          )}
          {tab === "messages" && <MessagesTab messages={messages} />}
          {tab === "plan" && state.plan && <PlanDetails plan={state.plan} checks={state.checks} />}
          {tab === "trace" && <TraceTab state={state} tokens={tokens} />}
        </>
      )}
    </div>
  );
}

// ---------- verdict + checks ----------
function Verdict({ state, six, rejected, tokens, calls }: { state: SessionState; six: Check[]; rejected: number; tokens: number; calls: number }) {
  const failed = six.filter((c) => !c.pass);
  const ok = six.length > 0 && failed.length === 0;
  return (
    <div className={`mb-4 flex flex-wrap items-center gap-4 rounded-2xl border-2 p-5 ${ok ? "border-emerald-300 bg-emerald-50" : "border-red-300 bg-red-50"}`}>
      <div className={`flex h-14 w-14 items-center justify-center rounded-full text-3xl font-black text-white ${ok ? "bg-emerald-500" : "bg-red-600"}`}>{ok ? "✓" : "!"}</div>
      <div className="min-w-0 flex-1">
        <div className={`text-xl font-black ${ok ? "text-emerald-900" : "text-red-900"}`}>{ok ? "The plan is valid — all 6 checks pass" : `The plan has problems — ${failed.length} of 6 checks fail`}</div>
        <div className="text-sm text-slate-700">
          {ok ? "Every figure below was computed and verified by code from the messages." : `Failing: ${failed.map((c) => CHECK_TEXT[c.id]).join(", ")}. See the red cards below.`}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
        <Fig k="Messages read" v={state.messages.length} />
        <Fig k="Rejected / held" v={rejected} warn={rejected > 0} />
        <Fig k="Model calls" v={calls} />
        <Fig k="Tokens used" v={tokens.toLocaleString()} />
      </div>
    </div>
  );
}
function Fig({ k, v, warn }: { k: string; v: string | number; warn?: boolean }) {
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{k}</div>
      <div className={`text-lg font-black ${warn ? "text-red-700" : "text-slate-900"}`}>{v}</div>
    </div>
  );
}
function ChecksGrid({ six }: { six: Check[] }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {six.map((c) => (
        <div key={c.id} className={`rounded-xl border p-3 ${c.pass ? "border-emerald-200 bg-white" : "border-red-300 bg-red-50"}`}>
          <div className="flex items-center gap-2">
            <span className={`flex h-6 w-6 items-center justify-center rounded-full text-sm font-black text-white ${c.pass ? "bg-emerald-500" : "bg-red-600"}`}>{c.pass ? "✓" : "✗"}</span>
            <span className="font-bold text-slate-900">{CHECK_TEXT[c.id] ?? c.label}</span>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-slate-600">{c.detail}</p>
        </div>
      ))}
    </div>
  );
}

// ---------- overview ----------
function AtAGlance({ plan }: { plan: Plan }) {
  const e = plan.event;
  const b = plan.budget;
  const used = b && b.limit ? Math.min(100, (b.total / b.limit) * 100) : 0;
  return (
    <Box title="The plan at a glance" hint="Each line shows which message the figure came from.">
      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
        <Big k="Participants" v={e.participants} refs={e.refs.participants} />
        <Big k="Teams" v={e.teams} refs={e.refs.teams} />
        <Big k="People on site" v={e.people_on_site} />
        <Big k="Meals to order" v={e.people_to_feed} />
        <Big k="Duration" v={`${e.duration_min} min`} refs={e.refs.duration} />
      </div>
      <dl className="divide-y divide-slate-100 text-sm">
        <Row k="Venue">
          {plan.venue ? (
            <>
              <b>{plan.venue.rooms.map((r) => r.name).join(" + ")}</b> — {plan.venue.capacity} seats for {e.people_on_site} people, {rs(plan.venue.cost)}
              <From refs={plan.venue.rooms.flatMap((r) => r.refs)} />
            </>
          ) : (
            <span className="font-semibold text-red-700">No room option fits</span>
          )}
        </Row>
        <Row k="Food">
          {plan.food ? (
            <>
              <b>{plan.food.tier}</b> — {plan.food.quantity} meals × {rs(plan.food.price_per_head)} {plan.food.fees.length ? `+ ${plan.food.fees.map((f) => f.label).join(", ")}` : ""} = <b>{rs(plan.food.cost)}</b>
              <From refs={plan.food.refs} />
            </>
          ) : (
            <span className="font-semibold text-red-700">No food options</span>
          )}
        </Row>
        <Row k="Judging">
          {plan.judging ? (
            <>
              <b>{plan.judging.judges_used} judges</b> for {e.teams} teams ({plan.judging.judges_per_team} per team) — {plan.judging.window_min} min judging, honoraria {rs(plan.judging.honoraria)}
              <From refs={plan.judging.refs} />
            </>
          ) : (
            "—"
          )}
        </Row>
        <Row k="Schedule">{plan.schedule && <Timeline plan={plan} compact />}</Row>
        <Row k="Budget">
          {b && (
            <div>
              <div>
                <b>{rs(b.total)}</b> of {rs(b.limit)} — <span className={b.remaining !== null && b.remaining < 0 ? "font-bold text-red-700" : "font-semibold text-emerald-700"}>{rs(b.remaining)} left</span>
              </div>
              <div className="mt-1 h-3 w-full overflow-hidden rounded-full bg-slate-200">
                <div className={`h-full ${b.limit !== null && b.total > b.limit ? "bg-red-600" : "bg-emerald-500"}`} style={{ width: `${used}%` }} />
              </div>
            </div>
          )}
        </Row>
      </dl>
    </Box>
  );
}
function Big({ k, v, refs }: { k: string; v: string | number; refs?: string[] }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-2" title={refs?.length ? `from ${refs.join(", ")}` : undefined}>
      <div className="text-[11px] font-semibold uppercase text-slate-500">{k}</div>
      <div className="text-xl font-black text-slate-900">{v}</div>
    </div>
  );
}
function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[90px_1fr] gap-3 py-2">
      <dt className="font-semibold text-slate-500">{k}</dt>
      <dd className="text-slate-800">{children}</dd>
    </div>
  );
}
function Timeline({ plan, compact }: { plan: Plan; compact?: boolean }) {
  const e = plan.event;
  const s0 = toMin(e.start);
  const blocks = plan.schedule?.blocks ?? [];
  return (
    <div>
      <div className="flex h-8 w-full overflow-hidden rounded-md border border-slate-200">
        {blocks.map((x, i) => (
          <div key={i} title={`${fmtClock(s0, x.start)} ${x.label} (${x.minutes} min)`} className={`${BLOCK_COLOR[x.kind]} flex items-center justify-center border-r border-white text-[10px] font-bold ${x.kind === "build" ? "text-slate-700" : "text-white"}`} style={{ width: `${(x.minutes / e.duration_min) * 100}%` }}>
            {x.minutes >= 25 ? x.label.split(/[ /&]/)[0] : ""}
          </div>
        ))}
      </div>
      <div className={`mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-slate-600 ${compact ? "" : "mt-2"}`}>
        {blocks.map((x, i) => (
          <span key={i}>
            <span className="font-mono font-semibold">{fmtClock(s0, x.start)}</span> {x.label.replace(" / hacking", "")} {x.minutes}m
          </span>
        ))}
      </div>
    </div>
  );
}
function LatestChange({ state }: { state: SessionState }) {
  const b = state.batches[state.batches.length - 1];
  if (!b) return null;
  const msgs = state.messages.filter((m) => m.batch === b.batch);
  return (
    <Box title={b.batch === 1 ? "First run" : `Latest update (batch ${b.batch})`} hint={`Input: ${b.file} · ${msgs.length} message${msgs.length === 1 ? "" : "s"} · ${(b.duration_ms / 1000).toFixed(1)} s`}>
      <div className="mb-3 grid gap-2 text-sm sm:grid-cols-2">
        <div className="rounded-lg border border-slate-200 p-3">
          <div className="text-xs font-semibold uppercase text-slate-500">Model calls made</div>
          <div className="mt-1">{b.areas_called.length ? b.areas_called.map((a) => <AreaTag key={a} a={a} />) : <span className="text-slate-500">none (decided by code)</span>}</div>
        </div>
        <div className="rounded-lg border border-slate-200 p-3">
          <div className="text-xs font-semibold uppercase text-slate-500">Recomputed by code (0 tokens)</div>
          <div className="mt-1 text-slate-800">{b.areas_recomputed.length ? b.areas_recomputed.join(", ") : "nothing changed"}</div>
        </div>
      </div>
      <ul className="mb-3 space-y-1 text-sm">
        {msgs.map((m) => (
          <li key={m.ref} className="flex flex-wrap items-start gap-2">
            <b className="w-10">{m.ref}</b>
            <StatusChip status={m.status} />
            <span className="flex-1 text-slate-700">{m.status === "applied" ? m.summary : m.reason}</span>
          </li>
        ))}
      </ul>
      {b.batch > 1 && (
        <>
          <div className="text-xs font-semibold uppercase text-slate-500">What changed in the plan</div>
          {b.diff.length === 0 ? (
            <p className="text-sm text-slate-500">No figure changed.</p>
          ) : (
            <table className="mt-1 w-full text-sm">
              <tbody>
                {b.diff.map((d) => (
                  <tr key={d.path} className="border-b border-slate-100">
                    <td className="py-1 pr-2 text-slate-500">{d.path.replace(".", " · ").replace(/_/g, " ")}</td>
                    <td className="py-1 pr-2 text-slate-400 line-through">{d.old}</td>
                    <td className="py-1 font-bold text-slate-900">→ {d.new}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </Box>
  );
}
function RejectedBox({ rejected }: { rejected: Message[] }) {
  return (
    <section className="rounded-xl border-2 border-red-300 bg-white p-5 shadow-sm">
      <h2 className="flex items-center gap-2 text-base font-bold text-red-800">
        Rejected or held messages <span className="rounded-full bg-red-600 px-2 text-sm text-white">{rejected.length}</span>
      </h2>
      <p className="mb-3 text-xs text-slate-500">These were kept out of the plan. The reason says why.</p>
      {rejected.length === 0 && <p className="text-sm text-slate-500">None.</p>}
      <ul className="space-y-3">
        {rejected.map((m) => (
          <li key={m.ref} className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm">
            <div className="flex items-center gap-2">
              <b>{m.ref}</b>
              <StatusChip status={m.status} />
              <span className="text-xs text-slate-500">
                {m.sender ?? "unknown"} · {m.role} · {m.date ?? "undated"}
              </span>
            </div>
            <p className="mt-1 text-slate-800">{m.reason}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
function RequestsBox({ plan }: { plan: Plan }) {
  return (
    <Box title="Money requests" hint="Never added to the budget unless an organiser or finance approves.">
      <ul className="space-y-1 text-sm">
        {plan.requests.map((r) => (
          <li key={r.ref + r.label}>
            <b>{r.ref}</b> {r.label} — {rs(r.amount)}{" "}
            <span className={r.approved ? "font-semibold text-emerald-700" : "text-slate-600"}>
              {r.approved ? "approved, in budget" : `not approved · ${r.affordable ? "would fit" : r.affordable === false ? "would not fit" : "—"} (${rs(plan.budget?.remaining)} left)`}
            </span>
          </li>
        ))}
      </ul>
    </Box>
  );
}
function AddMessage({ sid, readOnly, onDone }: { sid: string | null; readOnly: boolean; onDone: (id: string) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  async function submit(newSession: boolean) {
    setBusy(true);
    setErr(null);
    try {
      const fd = new FormData();
      const f = fileRef.current?.files?.[0];
      if (f) fd.append("file", f);
      else fd.append("text", text);
      if (!newSession && sid) fd.append("session_id", sid);
      const r = await fetch("/api/ingest", { method: "POST", body: fd });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setText("");
      if (fileRef.current) fileRef.current.value = "";
      onDone(j.session_id);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={5} placeholder="Paste message text here…" className="w-full rounded-lg border border-slate-300 bg-white p-2 font-mono text-xs focus:border-indigo-500 focus:outline-none" />
      <input ref={fileRef} type="file" className="mt-2 block w-full text-xs text-slate-600" />
      <div className="mt-2 flex flex-wrap gap-2">
        {sid && (
          <button disabled={busy || readOnly} onClick={() => submit(false)} className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white disabled:opacity-40" title={readOnly ? "CLI sessions are read-only in the web UI" : ""}>
            {busy ? "Working…" : "Update this plan"}
          </button>
        )}
        <button disabled={busy} onClick={() => submit(true)} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold disabled:opacity-40">
          Start a new plan
        </button>
      </div>
      {readOnly && <p className="mt-2 text-xs text-amber-700">This session comes from the CLI, so it can only be viewed here. Start a new plan to try the web flow.</p>}
      {err && <p className="mt-2 text-sm font-semibold text-red-700">{err}</p>}
    </div>
  );
}

// ---------- messages tab ----------
function MessagesTab({ messages }: { messages: Message[] }) {
  return (
    <div className="space-y-4">
      <Box title="What the statuses mean">
        <ul className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
          {Object.entries(STATUS).map(([k, s]) => (
            <li key={k} className="flex items-start gap-2">
              <StatusChip status={k} />
              <span className="text-slate-600">{s.meaning}</span>
            </li>
          ))}
        </ul>
      </Box>
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
            <tr>
              <th className="px-3 py-2">#</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">From</th>
              <th className="px-3 py-2">Date</th>
              <th className="px-3 py-2">What it says</th>
              <th className="px-3 py-2">Decision</th>
            </tr>
          </thead>
          <tbody>
            {messages.map((m) => (
              <tr key={m.ref} className={`border-t border-slate-100 align-top ${STATUS[m.status]?.row ?? ""}`}>
                <td className="px-3 py-2 font-bold">{m.ref}</td>
                <td className="px-3 py-2">
                  <StatusChip status={m.status} />
                </td>
                <td className="px-3 py-2">
                  <div className="font-semibold">{m.sender ?? "unknown"}</div>
                  <div className="text-xs text-slate-500">{m.role.replace(/_/g, " ")}</div>
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-xs text-slate-500">{m.date ?? "undated"}</td>
                <td className="px-3 py-2">{m.summary}</td>
                <td className="px-3 py-2 text-xs text-slate-600">{m.status === "applied" ? `${m.facts.filter((f) => f.status === "active").length} fact(s) used` : m.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------- plan details tab ----------
function PlanDetails({ plan, checks }: { plan: Plan; checks: Check[] }) {
  const e = plan.event;
  const b = plan.budget;
  const constraints = checks.filter((c) => c.id === "constraint");
  const seating = seatingPlan(plan);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Box title="Venue" hint={plan.venue?.reason}>
        {plan.venue ? (
          <ul className="space-y-1 text-sm">
            {plan.venue.rooms.map((r) => (
              <li key={r.name}>
                <b>{r.name}</b> — {r.capacity} seats, {rs(r.cost)}
                {r.attrs.length ? <span className="text-slate-500"> · {r.attrs.join(", ").replace(/_/g, " ")}</span> : null}
                <From refs={r.refs} />
              </li>
            ))}
            <li className="pt-1 text-slate-600">
              Total {plan.venue.capacity} seats for {e.people_on_site} people on site ({plan.venue.headroom} spare).
            </li>
            {plan.venue.unverified_attrs?.length > 0 && <li className="text-amber-700">To arrange on site (no venue lists it): {plan.venue.unverified_attrs.join(", ").replace(/_/g, " ")}</li>}
          </ul>
        ) : (
          <p className="text-sm font-semibold text-red-700">No room option fits.</p>
        )}
      </Box>
      <Box title="Food" hint={plan.food?.reason}>
        {plan.food ? (
          <ul className="space-y-1 text-sm">
            <li>
              <b>{plan.food.tier}</b>: {plan.food.quantity} meals × {rs(plan.food.price_per_head)} = {rs(plan.food.price_per_head * plan.food.quantity)}
              <From refs={plan.food.refs} />
            </li>
            {plan.food.fees.map((f) => (
              <li key={f.label}>
                + {f.label}: {rs(f.amount)}
                <From refs={f.refs} />
              </li>
            ))}
            {plan.food.diets.length > 0 && <li>Dietary: {plan.food.diets.map((d) => `${d.count} ${d.diet}`).join(", ")} (inside the {plan.food.quantity})</li>}
            <li className="pt-1 font-bold">Food total {rs(plan.food.cost)}</li>
            <li className="text-xs text-slate-500">Meals = participants {e.participants} + staff {e.staff} + judges {plan.judging?.judges_used ?? 0}{e.people_to_feed - e.participants - e.staff - (plan.judging?.judges_used ?? 0) > 0 ? ` + others ${e.people_to_feed - e.participants - e.staff - (plan.judging?.judges_used ?? 0)}` : ""}</li>
          </ul>
        ) : (
          <p className="text-sm font-semibold text-red-700">No food options.</p>
        )}
      </Box>
      <Box title="Schedule" hint={`${e.duration_min} minutes${e.start ? `, ${e.start}–${e.end}` : " (relative times — no start time stated)"}`} className="lg:col-span-2">
        {plan.schedule && (
          <>
            <Timeline plan={plan} />
            <table className="mt-3 w-full text-sm">
              <tbody>
                {plan.schedule.blocks.map((x, i) => (
                  <tr key={i} className="border-b border-slate-100">
                    <td className="w-36 py-1 font-mono">
                      {fmtClock(toMin(e.start), x.start)}–{fmtClock(toMin(e.start), x.start + x.minutes)}
                    </td>
                    <td className="py-1">
                      {x.label}
                      <From refs={x.refs} />
                    </td>
                    <td className="py-1 text-right">{x.minutes} min</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </Box>
      <Box title="Judging" hint={plan.judging ? `${plan.judging.judges_used} used · ${plan.judging.judges_needed} needed · ${plan.judging.available} available · ${plan.judging.minutes_per_team} min per team · window ${plan.judging.window_min} min` : undefined}>
        {plan.judging && (
          <div className="grid grid-cols-2 gap-1 text-xs sm:grid-cols-3">
            {plan.judging.assignments.map((a) => (
              <div key={a.team} className="rounded border border-slate-200 bg-slate-50 px-2 py-1">
                <b>{a.team}</b>: {a.judges.join(", ")}
              </div>
            ))}
          </div>
        )}
      </Box>
      <Box title="Budget" hint={b ? `${rs(b.total)} of ${rs(b.limit)} · ${rs(b.remaining)} left` : undefined}>
        {b && (
          <table className="w-full text-sm">
            <tbody>
              {b.items.map((i) => (
                <tr key={i.label} className="border-b border-slate-100">
                  <td className="py-1">
                    {i.label}
                    {i.detail ? <span className="text-xs text-slate-500"> ({i.detail})</span> : null}
                    <From refs={i.refs} />
                  </td>
                  <td className="py-1 text-right font-mono">{rs(i.amount)}</td>
                </tr>
              ))}
              {b.tax > 0 && (
                <tr className="border-b border-slate-100">
                  <td className="py-1">Tax</td>
                  <td className="py-1 text-right font-mono">{rs(b.tax)}</td>
                </tr>
              )}
              {b.reserve > 0 && (
                <tr className="border-b border-slate-100">
                  <td className="py-1">Reserve</td>
                  <td className="py-1 text-right font-mono">{rs(b.reserve)}</td>
                </tr>
              )}
              <tr className="font-black">
                <td className="py-1">Total</td>
                <td className="py-1 text-right font-mono">{rs(b.total)}</td>
              </tr>
            </tbody>
          </table>
        )}
      </Box>
      <Box
        title="Seating plan"
        hint={`${seating.totals.tables} tables · ${seating.totals.participants} participants seated · ${seating.totals.seated} of ${seating.totals.capacity} places used (staff desk and judges included)`}
        className="lg:col-span-2"
      >
        {seating.rooms.length === 0 && <p className="text-sm text-slate-500">No rooms to seat.</p>}
        <div className="space-y-4">
          {seating.rooms.map((r) => (
            <div key={r.name}>
              <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2 text-sm">
                <span>
                  <b>{r.name}</b>
                  <From refs={r.refs} />
                </span>
                <span className={r.seated > r.capacity ? "font-bold text-red-700" : "text-slate-600"}>
                  <b>{r.seated}</b> / {r.capacity} seated
                  {r.desk ? ` · ${r.desk.label}: ${r.desk.staff} staff` : ""}
                  {r.judges.length ? ` · judges here: ${r.judges.join(", ")}` : ""}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-1 text-xs sm:grid-cols-3 lg:grid-cols-4">
                {r.tables.map((t) => (
                  <div key={t.table} className="rounded border border-slate-200 bg-slate-50 px-2 py-1">
                    <b>{t.table}</b> · {t.team} · {t.seats} seats{t.judges.length ? ` · ${t.judges.join(", ")}` : ""}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        {seating.unseated.length > 0 && (
          <div className="mt-3 grid grid-cols-2 gap-1 text-xs sm:grid-cols-3 lg:grid-cols-4">
            {seating.unseated.map((t) => (
              <div key={t.team} className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-amber-800">
                <b>Unseated</b> · {t.team} · {t.seats} seats{t.judges.length ? ` · ${t.judges.join(", ")}` : ""}
              </div>
            ))}
          </div>
        )}
        {seating.notes.length > 0 && (
          <ul className="mt-3 space-y-1 text-sm text-amber-700">
            {seating.notes.map((n, i) => (
              <li key={i}>⚠ {n}</li>
            ))}
          </ul>
        )}
      </Box>
      {constraints.length > 0 && (
        <Box title="Rules from the messages" hint="Every hard constraint stated in a message, checked by code." className="lg:col-span-2">
          <ul className="space-y-1 text-sm">
            {constraints.map((c, i) => (
              <li key={i} className={c.pass ? "text-slate-800" : c.advisory ? "text-amber-700" : "text-red-700"}>
                {c.pass ? "✓" : c.advisory ? "⚠" : "✗"} {c.label} — <span className="text-slate-500">{c.detail}</span>
              </li>
            ))}
          </ul>
        </Box>
      )}
    </div>
  );
}

// ---------- trace tab ----------
function TraceTab({ state, tokens }: { state: SessionState; tokens: { prompt: number; completion: number; total: number; reasoning: number } }) {
  return (
    <div className="space-y-4">
      <Box title="Token use (exactly as reported by the API)">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Big k="Prompt" v={tokens.prompt.toLocaleString()} />
          <Big k="Completion" v={tokens.completion.toLocaleString()} />
          <Big k="Reasoning (in completion)" v={tokens.reasoning.toLocaleString()} />
          <Big k="Total" v={tokens.total.toLocaleString()} />
        </div>
      </Box>
      {state.batches.map((b) => (
        <Box key={b.batch} title={`Batch ${b.batch} · ${b.file}`} hint={`Model calls: ${b.calls.length} (${b.areas_called.join(", ") || "none"}) · recomputed by code: ${b.areas_recomputed.join(", ") || "nothing"}`}>
          {state.calls
            .filter((c) => b.calls.includes(c.seq))
            .map((c) => (
              <CallView key={c.seq} c={c} />
            ))}
          <div className="mt-3 text-xs font-bold uppercase text-slate-500">Jev decisions (code, 0 tokens)</div>
          <ul className="mt-1 space-y-0.5 text-xs">
            {state.decisions
              .filter((d) => d.batch === b.batch)
              .map((d, i) => (
                <li key={i} className={d.kind === "rejected" ? "text-red-700" : d.kind === "needs_decision" ? "text-orange-700" : "text-slate-700"}>
                  <b>{d.kind}</b> {d.ref ?? ""} — {d.reason}
                </li>
              ))}
          </ul>
        </Box>
      ))}
    </div>
  );
}
function CallView({ c }: { c: CallRecord }) {
  return (
    <details className="mb-2 rounded-lg border border-slate-200">
      <summary className="cursor-pointer px-3 py-2 text-sm">
        <b>#{c.seq}</b> <AreaTag a={c.area} />
        <span className="font-mono">model={c.model}</span> · {c.usage ? `prompt ${c.usage.prompt_tokens} + completion ${c.usage.completion_tokens} = ${c.usage.total_tokens} tokens` : "no usage returned"}
        {c.usage?.reasoning_tokens ? ` (reasoning ${c.usage.reasoning_tokens})` : ""} · {(c.latency_ms / 1000).toFixed(1)} s{c.error ? <span className="text-red-700"> · {c.error}</span> : null}
        <span className="ml-2 text-xs text-slate-400">click to see full input and output</span>
      </summary>
      <div className="space-y-2 border-t border-slate-200 p-3">
        <div className="text-xs font-bold uppercase text-slate-500">Input (system + user)</div>
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-2 font-mono text-[11px] text-slate-800">{`[system]\n${c.system}\n[user]\n${c.user}`}</pre>
        <div className="text-xs font-bold uppercase text-slate-500">Raw output</div>
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-2 font-mono text-[11px] text-slate-800">{c.output}</pre>
        <div className="font-mono text-[11px] text-slate-600">usage (verbatim): {JSON.stringify(c.usage_raw)}</div>
      </div>
    </details>
  );
}
