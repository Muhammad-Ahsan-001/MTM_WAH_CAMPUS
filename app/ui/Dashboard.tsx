"use client";

import { createClient } from "@supabase/supabase-js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fmtClock, toMin } from "../../src/core/jev/solve";
import { finalMarkdown } from "../../src/core/render";
import type { CallRecord } from "../../src/core/llm";
import type { Check, Message, Plan, SessionState } from "../../src/core/types";

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);

type SessionRow = { id: string; label: string; source: "cli" | "web"; updated_at: string };

const STATUS: Record<string, { label: string; cls: string }> = {
  applied: { label: "Applied", cls: "bg-emerald-100 text-emerald-900 ring-emerald-300 dark:bg-emerald-900/40 dark:text-emerald-200" },
  superseded: { label: "Superseded", cls: "bg-amber-100 text-amber-900 ring-amber-300 dark:bg-amber-900/40 dark:text-amber-200" },
  irrelevant: { label: "Irrelevant", cls: "bg-slate-200 text-slate-700 ring-slate-300 dark:bg-slate-800 dark:text-slate-300" },
  request: { label: "Request", cls: "bg-sky-100 text-sky-900 ring-sky-300 dark:bg-sky-900/40 dark:text-sky-200" },
  rejected: { label: "Rejected", cls: "bg-red-600 text-white ring-red-700" },
  duplicate: { label: "Duplicate", cls: "bg-slate-200 text-slate-700 ring-slate-300 dark:bg-slate-800 dark:text-slate-300" },
  needs_decision: { label: "Held", cls: "bg-orange-500 text-white ring-orange-600" },
};
const AREA: Record<string, string> = {
  reading: "bg-indigo-600",
  venue: "bg-violet-600",
  schedule: "bg-sky-600",
  food: "bg-orange-600",
  judging: "bg-emerald-600",
  budget: "bg-rose-600",
};
const BLOCK: Record<string, string> = {
  opening: "bg-indigo-500",
  build: "bg-slate-400 dark:bg-slate-600",
  lunch: "bg-orange-500",
  judging: "bg-emerald-600",
  closing: "bg-violet-600",
  required: "bg-amber-500",
};
const rs = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `Rs ${n.toLocaleString("en-US")}`);

function Chip({ refs }: { refs?: string[] }) {
  if (!refs?.length) return null;
  return <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">from {[...new Set(refs)].join(", ")}</span>;
}

function Card({ title, children, refs }: { title: string; children: React.ReactNode; refs?: string[] }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <h3 className="mb-2 flex items-center text-sm font-bold uppercase tracking-wide text-slate-500">
        {title}
        <Chip refs={refs} />
      </h3>
      {children}
    </section>
  );
}

export default function Dashboard() {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [sid, setSid] = useState<string | null>(null);
  const [state, setState] = useState<SessionState | null>(null);
  const [source, setSource] = useState<"cli" | "web">("web");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadSessions = useCallback(async () => {
    const { data } = await supabase.from("sessions").select("id,label,source,updated_at").order("updated_at", { ascending: false }).limit(50);
    setSessions((data as SessionRow[]) ?? []);
    return (data as SessionRow[]) ?? [];
  }, []);
  const loadState = useCallback(async (id: string) => {
    const { data } = await supabase.from("sessions").select("state,source").eq("id", id).maybeSingle();
    if (data) {
      setState(data.state as SessionState);
      setSource(data.source);
    }
  }, []);

  useEffect(() => {
    loadSessions().then((rows) => {
      if (rows[0]) setSid((cur) => cur ?? rows[0].id);
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

  async function submit(newSession: boolean) {
    setBusy(true);
    setErr(null);
    try {
      const fd = new FormData();
      const f = fileRef.current?.files?.[0];
      if (f) fd.append("file", f);
      else fd.append("text", text);
      if (!newSession && sid && source === "web") fd.append("session_id", sid);
      const r = await fetch("/api/ingest", { method: "POST", body: fd });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setText("");
      if (fileRef.current) fileRef.current.value = "";
      await loadSessions();
      setSid(j.session_id);
      await loadState(j.session_id);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const calls = state?.calls ?? [];
  const tokens = useMemo(() => {
    const t = { prompt: 0, completion: 0, total: 0, reasoning: 0, cached: 0 };
    for (const c of calls) {
      if (!c.usage) continue;
      t.prompt += c.usage.prompt_tokens;
      t.completion += c.usage.completion_tokens;
      t.total += c.usage.total_tokens;
      t.reasoning += c.usage.reasoning_tokens ?? 0;
      t.cached += c.usage.cached_tokens ?? 0;
    }
    return t;
  }, [calls]);
  const models = [...new Set(calls.map((c) => c.model).filter((m) => m !== "(no response)"))];
  const six = (state?.checks ?? []).filter((c) => c.id !== "constraint");
  const rejected = (state?.messages ?? []).filter((m) => m.status === "rejected" || m.status === "needs_decision");
  const lastBatch = state?.batches[state.batches.length - 1];

  function download() {
    if (!state) return;
    const blob = new Blob([finalMarkdown(state)], { type: "text/markdown" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "final-plan-and-trace.md";
    a.click();
  }

  return (
    <div className="mx-auto max-w-[1600px] px-4 py-4">
      {/* Header */}
      <header className="mb-4 flex flex-wrap items-center gap-3 rounded-xl bg-slate-900 px-4 py-3 text-white shadow">
        <div className="mr-2">
          <div className="text-xl font-black tracking-tight">SceneBnao</div>
          <div className="text-[11px] text-slate-300">the model reads, Jev decides</div>
        </div>
        <select className="rounded-md bg-slate-800 px-2 py-1.5 text-sm ring-1 ring-slate-600" value={sid ?? ""} onChange={(e) => setSid(e.target.value)}>
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.source === "cli" ? "[CLI] " : ""}
              {s.label || s.id.slice(0, 8)}
            </option>
          ))}
        </select>
        {source === "cli" && <span className="rounded bg-amber-400 px-2 py-0.5 text-xs font-bold text-slate-900">CLI · read-only · live</span>}
        <span className="rounded-md bg-indigo-600 px-2 py-1 text-xs font-semibold" title="Exact model field from the API responses">
          Model: {models.join(", ") || "—"} — declared as our small model (no official list, confirmed at help desk)
        </span>
        <span className="rounded-md bg-slate-800 px-2 py-1 font-mono text-xs">
          tokens {tokens.total.toLocaleString()} (prompt {tokens.prompt.toLocaleString()} · completion {tokens.completion.toLocaleString()} · reasoning {tokens.reasoning.toLocaleString()}) · {calls.length} calls
        </span>
        <div className="ml-auto flex flex-wrap gap-1.5">
          {six.map((c) => (
            <span key={c.id} title={c.detail} className={`rounded-md px-2 py-1 text-xs font-bold ${c.pass ? "bg-emerald-500 text-white" : "bg-red-600 text-white"}`}>
              {c.pass ? "✓" : "✗"} {c.id}
            </span>
          ))}
          <button onClick={download} disabled={!state} className="rounded-md bg-white px-2 py-1 text-xs font-bold text-slate-900 disabled:opacity-40">
            ⬇ plan + trace .md
          </button>
        </div>
      </header>

      <div className="grid gap-4 lg:grid-cols-12">
        {/* Left: input + messages */}
        <div className="space-y-4 lg:col-span-3">
          <section className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-800 dark:bg-slate-900">
            <h3 className="mb-2 text-sm font-bold uppercase tracking-wide text-slate-500">Add message(s)</h3>
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={5} placeholder="Paste a pack or one new message…" className="w-full rounded-md border border-slate-300 bg-slate-50 p-2 font-mono text-xs dark:border-slate-700 dark:bg-slate-950" />
            <input ref={fileRef} type="file" className="mt-2 block w-full text-xs" />
            <div className="mt-2 flex gap-2">
              <button disabled={busy || source === "cli" || !sid} onClick={() => submit(false)} className="flex-1 rounded-md bg-slate-900 px-2 py-1.5 text-xs font-bold text-white disabled:opacity-40 dark:bg-white dark:text-slate-900">
                {busy ? "Running…" : "Update this session"}
              </button>
              <button disabled={busy} onClick={() => submit(true)} className="flex-1 rounded-md bg-indigo-600 px-2 py-1.5 text-xs font-bold text-white disabled:opacity-40">
                New session
              </button>
            </div>
            {err && <p className="mt-2 text-xs font-semibold text-red-600">{err}</p>}
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-800 dark:bg-slate-900">
            <h3 className="mb-2 text-sm font-bold uppercase tracking-wide text-slate-500">Messages ({state?.messages.length ?? 0})</h3>
            <ul className="space-y-2">
              {(state?.messages ?? []).map((m) => (
                <MessageRow key={m.ref} m={m} />
              ))}
            </ul>
          </section>
        </div>

        {/* Center: change view + plan */}
        <div className="space-y-4 lg:col-span-6">
          {lastBatch && (
            <section className="rounded-xl border-2 border-indigo-300 bg-indigo-50 p-3 text-sm dark:border-indigo-800 dark:bg-indigo-950/40">
              <div className="flex flex-wrap items-center gap-2">
                <b>Batch {lastBatch.batch}</b>
                <span className="text-slate-500">{lastBatch.file}</span>
                <span className="ml-auto text-xs">
                  model-call areas: {lastBatch.areas_called.map((a) => <AreaTag key={a} a={a} />)} · recomputed by code (0 tokens):{" "}
                  {lastBatch.areas_recomputed.map((a) => (
                    <span key={a} className="mr-1 rounded bg-slate-200 px-1.5 py-0.5 text-[11px] font-semibold dark:bg-slate-800">
                      {a}
                    </span>
                  ))}
                </span>
              </div>
              {lastBatch.batch > 1 && (
                <ul className="mt-2 grid gap-1 font-mono text-xs sm:grid-cols-2">
                  {lastBatch.diff.length === 0 && <li className="text-slate-500">no figure changed</li>}
                  {lastBatch.diff.map((d) => (
                    <li key={d.path}>
                      <span className="text-slate-500">{d.path}</span> <span className="line-through opacity-60">{d.old}</span> → <b className="rounded bg-yellow-200 px-1 text-slate-900">{d.new}</b>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
          {state?.plan ? <PlanView plan={state.plan} checks={state.checks} /> : <p className="text-slate-500">No plan yet. Paste a pack and start a new session, or run the CLI.</p>}
        </div>

        {/* Right: rejected + trace */}
        <div className="space-y-4 lg:col-span-3">
          <section className="rounded-xl border-2 border-red-300 bg-white p-3 shadow-sm dark:border-red-900 dark:bg-slate-900">
            <h3 className="mb-2 flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-red-700">
              Rejected / held <span className="rounded-full bg-red-600 px-2 text-xs text-white">{rejected.length}</span>
            </h3>
            {rejected.length === 0 && <p className="text-xs text-slate-500">none</p>}
            <ul className="space-y-2">
              {rejected.map((m) => (
                <li key={m.ref} className="text-xs">
                  <b className="text-red-700">{m.ref}</b> <span className="text-slate-500">({m.role}, {m.date ?? "undated"})</span>
                  <div>{m.reason}</div>
                </li>
              ))}
            </ul>
          </section>
          <section className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-800 dark:bg-slate-900">
            <h3 className="mb-2 text-sm font-bold uppercase tracking-wide text-slate-500">Trace</h3>
            {(state?.batches ?? []).map((b) => (
              <div key={b.batch} className="mb-3">
                <div className="text-xs font-bold">
                  ═ Batch {b.batch} · {b.file}
                </div>
                {calls.filter((c) => b.calls.includes(c.seq)).map((c) => (
                  <CallView key={c.seq} c={c} />
                ))}
                <div className="mt-1 text-[11px] font-semibold text-slate-500">JEV (code, 0 tokens)</div>
                <ul className="text-[11px]">
                  {(state?.decisions ?? [])
                    .filter((d) => d.batch === b.batch)
                    .map((d, i) => (
                      <li key={i} className={d.kind === "rejected" ? "text-red-600" : d.kind === "needs_decision" ? "text-orange-600" : ""}>
                        {d.kind} {d.ref ?? ""} — {d.reason}
                      </li>
                    ))}
                </ul>
              </div>
            ))}
          </section>
        </div>
      </div>
    </div>
  );
}

function AreaTag({ a }: { a: string }) {
  return <span className={`mr-1 rounded px-1.5 py-0.5 text-[11px] font-bold text-white ${AREA[a] ?? "bg-slate-500"}`}>{a}</span>;
}

function MessageRow({ m }: { m: Message }) {
  const s = STATUS[m.status] ?? STATUS.applied;
  const bad = m.status === "rejected" || m.status === "needs_decision";
  return (
    <li className={`rounded-md border p-2 text-xs ${bad ? "border-red-400 bg-red-50 dark:bg-red-950/30" : "border-slate-200 dark:border-slate-800"}`}>
      <div className="flex items-center gap-1.5">
        <b>{m.ref}</b>
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ring-1 ${s.cls}`}>{s.label}</span>
        <span className="text-slate-500">{m.role}</span>
        <span className="ml-auto text-slate-400">{m.date ?? "undated"}</span>
      </div>
      <div className="mt-1">
        {m.sender ? <b>{m.sender}: </b> : null}
        {m.summary}
      </div>
      {m.status !== "applied" && m.reason && <div className={`mt-1 ${bad ? "font-semibold text-red-700" : "text-slate-500"}`}>{m.reason}</div>}
    </li>
  );
}

function CallView({ c }: { c: CallRecord }) {
  return (
    <details className="mt-1 rounded border border-slate-200 text-xs dark:border-slate-800">
      <summary className="cursor-pointer px-2 py-1">
        <b>#{c.seq}</b> <AreaTag a={c.area} />
        <span className="font-mono">{c.model}</span> · {c.usage ? `${c.usage.prompt_tokens}+${c.usage.completion_tokens}=${c.usage.total_tokens} tok` : "no usage"}
        {c.usage?.reasoning_tokens ? ` (reasoning ${c.usage.reasoning_tokens})` : ""} · {(c.latency_ms / 1000).toFixed(1)}s{c.error ? <span className="text-red-600"> · {c.error}</span> : null}
      </summary>
      <div className="space-y-1 p-2">
        <div className="font-semibold">INPUT</div>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-slate-950 p-2 font-mono text-[10px] text-slate-100">{`[system]\n${c.system}\n[user]\n${c.user}`}</pre>
        <div className="font-semibold">OUTPUT</div>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-slate-950 p-2 font-mono text-[10px] text-slate-100">{c.output}</pre>
        <div className="font-mono text-[10px]">usage (as returned): {JSON.stringify(c.usage_raw)}</div>
      </div>
    </details>
  );
}

function PlanView({ plan, checks }: { plan: Plan; checks: Check[] }) {
  const e = plan.event;
  const s0 = toMin(e.start);
  const b = plan.budget;
  const used = b && b.limit ? Math.min(100, (b.total / b.limit) * 100) : 0;
  const constraints = checks.filter((c) => c.id === "constraint");
  return (
    <div className="space-y-4">
      <Card title="Event" refs={[...e.refs.participants, ...e.refs.teams, ...e.refs.budget_total]}>
        <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-5">
          <Stat k="Participants" v={e.participants} />
          <Stat k="Teams" v={e.teams} />
          <Stat k="On site" v={e.people_on_site} />
          <Stat k="To feed" v={e.people_to_feed} />
          <Stat k="Duration" v={`${e.duration_min} min`} />
        </div>
      </Card>
      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Venue" refs={plan.venue?.rooms.flatMap((r) => r.refs)}>
          {plan.venue ? (
            <>
              {plan.venue.rooms.map((r) => (
                <div key={r.name} className="text-sm">
                  <b>{r.name}</b> — cap {r.capacity}, {rs(r.cost)} {r.attrs.length ? <span className="text-slate-500">({r.attrs.join(", ")})</span> : null}
                </div>
              ))}
              <p className="mt-1 text-xs text-slate-500">
                {plan.venue.capacity} seats for {e.people_on_site} (headroom {plan.venue.headroom}). {plan.venue.reason}
              </p>
            </>
          ) : (
            <p className="text-sm text-red-600">No feasible venue</p>
          )}
        </Card>
        <Card title="Food" refs={plan.food?.refs}>
          {plan.food ? (
            <div className="text-sm">
              <b>{plan.food.tier}</b> {rs(plan.food.price_per_head)}/head × <b>{plan.food.quantity}</b>
              {plan.food.fees.map((f) => (
                <div key={f.label} className="text-xs">
                  + {f.label} {rs(f.amount)}
                </div>
              ))}
              {plan.food.diets.length > 0 && <div className="text-xs">Dietary: {plan.food.diets.map((d) => `${d.count} ${d.diet}`).join(", ")}</div>}
              <div className="mt-1 font-semibold">Total {rs(plan.food.cost)}</div>
              <p className="text-xs text-slate-500">{plan.food.reason}</p>
            </div>
          ) : (
            <p className="text-sm text-red-600">No food plan</p>
          )}
        </Card>
      </div>
      <Card title="Schedule" refs={plan.schedule?.blocks.flatMap((x) => x.refs)}>
        {plan.schedule && (
          <>
            <div className="flex h-10 w-full overflow-hidden rounded-md">
              {plan.schedule.blocks.map((x, i) => (
                <div key={i} title={`${x.label} ${x.minutes} min`} className={`${BLOCK[x.kind]} flex items-center justify-center border-r border-white/40 text-[10px] font-bold text-white`} style={{ width: `${(x.minutes / e.duration_min) * 100}%` }}>
                  {x.minutes >= 20 ? x.label.split(" ")[0] : ""}
                </div>
              ))}
            </div>
            <ul className="mt-2 grid gap-x-4 text-xs sm:grid-cols-2">
              {plan.schedule.blocks.map((x, i) => (
                <li key={i}>
                  <span className="font-mono">
                    {fmtClock(s0, x.start)}–{fmtClock(s0, x.start + x.minutes)}
                  </span>{" "}
                  {x.label} ({x.minutes}m)
                  <Chip refs={x.refs} />
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>
      <Card title="Judging" refs={plan.judging?.refs}>
        {plan.judging && (
          <div className="text-sm">
            <div>
              <b>{plan.judging.judges_used}</b> judges used / {plan.judging.judges_needed} needed / {plan.judging.available} available · {plan.judging.judges_per_team}/team · window {plan.judging.window_min} min · honoraria {rs(plan.judging.honoraria)}
            </div>
            <div className="mt-2 grid grid-cols-2 gap-1 text-xs sm:grid-cols-4">
              {plan.judging.assignments.map((a) => (
                <div key={a.team} className="rounded bg-slate-100 px-2 py-1 dark:bg-slate-800">
                  <b>{a.team}</b>: {a.judges.join(", ")}
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>
      <Card title="Budget" refs={plan.budget?.items.flatMap((i) => i.refs)}>
        {b && (
          <>
            <table className="w-full text-sm">
              <tbody>
                {b.items.map((i) => (
                  <tr key={i.label} className="border-b border-slate-100 dark:border-slate-800">
                    <td className="py-1">
                      {i.label} {i.detail ? <span className="text-xs text-slate-500">({i.detail})</span> : null}
                      <Chip refs={i.refs} />
                    </td>
                    <td className="py-1 text-right font-mono">{rs(i.amount)}</td>
                  </tr>
                ))}
                {b.tax > 0 && (
                  <tr>
                    <td>Tax</td>
                    <td className="text-right font-mono">{rs(b.tax)}</td>
                  </tr>
                )}
                {b.reserve > 0 && (
                  <tr>
                    <td>Reserve</td>
                    <td className="text-right font-mono">{rs(b.reserve)}</td>
                  </tr>
                )}
                <tr className="font-bold">
                  <td>Total</td>
                  <td className="text-right font-mono">{rs(b.total)}</td>
                </tr>
              </tbody>
            </table>
            <div className="mt-2 h-4 w-full overflow-hidden rounded bg-slate-200 dark:bg-slate-800">
              <div className={`h-full ${b.limit !== null && b.total > b.limit ? "bg-red-600" : "bg-emerald-500"}`} style={{ width: `${used}%` }} />
            </div>
            <div className="mt-1 text-xs">
              used {rs(b.total)} of {rs(b.limit)} · remaining <b>{rs(b.remaining)}</b>
            </div>
            {plan.requests.length > 0 && (
              <div className="mt-2 text-xs">
                <b>Requests (not committed unless approved)</b>
                {plan.requests.map((r) => (
                  <div key={r.ref + r.label}>
                    {r.ref} {r.label} {rs(r.amount)} — {r.approved ? "approved" : `affordable: ${r.affordable === null ? "n/a" : r.affordable ? "yes" : "no"}`}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </Card>
      {constraints.length > 0 && (
        <Card title="Hard constraints">
          <ul className="text-xs">
            {constraints.map((c, i) => (
              <li key={i} className={c.pass ? "" : c.advisory ? "text-amber-700" : "text-red-600"}>
                {c.pass ? "✓" : c.advisory ? "⚠" : "✗"} {c.label} — {c.detail}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function Stat({ k, v }: { k: string; v: string | number }) {
  return (
    <div className="rounded-lg bg-slate-100 p-2 dark:bg-slate-800">
      <div className="text-[11px] uppercase text-slate-500">{k}</div>
      <div className="text-lg font-black">{v}</div>
    </div>
  );
}
