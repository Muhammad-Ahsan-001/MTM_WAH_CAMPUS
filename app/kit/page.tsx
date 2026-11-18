"use client";

import { createClient } from "@supabase/supabase-js";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import KitInputs from "../../components/kit/KitInputs";
import Messages from "../../components/kit/Messages";
import PrintPack from "../../components/kit/PrintPack";
import SeatingPlanner from "../../components/kit/SeatingPlanner";
import type { SessionState } from "../../src/core/types";
import { defaultDeadline, EMPTY_INPUTS, parseSeating, type KitInputs as Inputs, type SeatTeam } from "../../src/extras/messages";
import "./kit.css";

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);

type SessionRow = { id: string; label: string; source: string; updated_at: string };
type Tab = "messages" | "seating" | "print";

function readInputs(sid: string): Inputs {
  try {
    const raw = localStorage.getItem(`kit:${sid}:inputs`);
    if (raw) return { ...EMPTY_INPUTS, ...(JSON.parse(raw) as Partial<Inputs>) };
  } catch {
    /* storage unavailable */
  }
  return EMPTY_INPUTS;
}
function readSeats(sid: string): SeatTeam[] | null {
  try {
    const raw = localStorage.getItem(`kit:${sid}:seating`);
    return raw ? parseSeating(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export default function KitPage() {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [sid, setSid] = useState<string | null>(null);
  const [state, setState] = useState<SessionState | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("messages");
  const [inputs, setInputs] = useState<Inputs>(EMPTY_INPUTS);
  const [seats, setSeats] = useState<SeatTeam[] | null>(null);

  const loadSessions = useCallback(async () => {
    const { data } = await supabase.from("sessions").select("id,label,source,updated_at").order("updated_at", { ascending: false }).limit(50);
    const rows = (data as SessionRow[]) ?? [];
    setSessions(rows);
    return rows;
  }, []);
  const loadState = useCallback(async (id: string) => {
    const { data } = await supabase.from("sessions").select("state").eq("id", id).maybeSingle();
    if (data) setState(data.state as SessionState);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadSessions().then((rows) => {
      if (rows[0]) setSid((cur) => cur ?? rows[0].id);
      else setLoading(false);
    });
    const ch = supabase
      .channel("kit-sessions-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "sessions" }, (payload) => {
        loadSessions();
        const row = payload.new as { id?: string; state?: SessionState };
        setSid((cur) => {
          if (row?.id && row.id === cur && row.state) setState(row.state);
          return cur;
        });
      })
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [loadSessions]);

  useEffect(() => {
    if (!sid) return;
    loadState(sid);
    setInputs(readInputs(sid));
    setSeats(readSeats(sid));
  }, [sid, loadState]);

  // seating allocation is written by the Seating tab (same tab) or another tab: re-read on storage events and tab switches
  useEffect(() => {
    if (!sid) return;
    const re = () => setSeats(readSeats(sid));
    window.addEventListener("storage", re);
    const iv = window.setInterval(re, 2000);
    return () => {
      window.removeEventListener("storage", re);
      window.clearInterval(iv);
    };
  }, [sid, tab]);

  const saveInputs = (v: Inputs) => {
    setInputs(v);
    if (!sid) return;
    try {
      localStorage.setItem(`kit:${sid}:inputs`, JSON.stringify(v));
    } catch {
      /* storage unavailable */
    }
  };

  const tabs: [Tab, string][] = [
    ["messages", "Group messages"],
    ["seating", "Seating"],
    ["print", "Print pack"],
  ];

  return (
    <main className="kit-root mx-auto max-w-6xl space-y-4 p-4 md:p-6">
      <header className="kit-chrome flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link href="/" className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100">
            ← Dashboard
          </Link>
          <h1 className="text-xl font-bold text-slate-900">Event Kit</h1>
          <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">0 tokens · templates from the plan</span>
        </div>
        <select className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900" value={sid ?? ""} onChange={(e) => setSid(e.target.value)}>
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label || s.id} · {s.source}
            </option>
          ))}
        </select>
      </header>

      {loading && <p className="kit-chrome text-sm text-slate-600">Loading…</p>}
      {!loading && !state && <p className="kit-chrome text-sm text-slate-600">No session found.</p>}

      {state && sid && (
        <>
          <nav className="kit-chrome flex gap-1 border-b border-slate-200">
            {tabs.map(([k, l]) => (
              <button key={k} type="button" onClick={() => setTab(k)} className={`-mb-px rounded-t-lg border px-4 py-2 text-sm font-medium ${tab === k ? "border-slate-200 border-b-white bg-white text-slate-900" : "border-transparent text-slate-600 hover:text-slate-900"}`}>
                {l}
              </button>
            ))}
          </nav>
          {tab === "messages" && (
            <div className="space-y-4">
              <KitInputs value={inputs} onChange={saveInputs} deadlineHint={state.plan ? defaultDeadline(state.plan) : ""} />
              <Messages state={state} inputs={inputs} seats={seats} />
            </div>
          )}
          {tab === "seating" && <SeatingPlanner sid={sid} state={state} />}
          {tab === "print" && <PrintPack state={state} inputs={inputs} seats={seats} />}
        </>
      )}
    </main>
  );
}
