"use client";

import Link from "next/link";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { useEffect, useMemo, useRef, useState } from "react";
import { REPORT_CSS, reportBodyHtml, reportHtml } from "../../src/core/md-html";
import { finalMarkdown, planMarkdown } from "../../src/core/render";
import type { SessionState } from "../../src/core/types";

type SessionRow = { id: string; label: string; source: "cli" | "web"; updated_at: string };
type Mode = "plan" | "full";
type LoadedFile = { name: string; text: string };

let client: SupabaseClient | null = null;
function supabase(): SupabaseClient {
  if (!client) client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
  return client;
}

const ACCEPT = /\.(md|markdown|txt)$/i;
const MAX_BYTES = 10 * 1024 * 1024;

export default function ReportPage() {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [sid, setSid] = useState("");
  const [state, setState] = useState<SessionState | null>(null);
  const [mode, setMode] = useState<Mode>("plan");
  const [file, setFile] = useState<LoadedFile | null>(null);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // session list
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { data, error } = await supabase().from("sessions").select("id,label,source,updated_at").order("updated_at", { ascending: false }).limit(50);
        if (error) throw new Error(error.message);
        if (!alive) return;
        const rows = (data as SessionRow[]) ?? [];
        setSessions(rows);
        if (rows[0]) setSid(rows[0].id);
        else setBusy(false);
      } catch (e) {
        if (!alive) return;
        setErr(`Could not load sessions: ${(e as Error).message}`);
        setBusy(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // selected session state
  useEffect(() => {
    if (!sid) return;
    let alive = true;
    setBusy(true);
    (async () => {
      try {
        const { data, error } = await supabase().from("sessions").select("state").eq("id", sid).maybeSingle();
        if (error) throw new Error(error.message);
        if (!alive) return;
        setState((data?.state as SessionState | undefined) ?? null);
        setErr(null);
      } catch (e) {
        if (alive) setErr(`Could not load that session: ${(e as Error).message}`);
      } finally {
        if (alive) setBusy(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [sid]);

  const { md, renderErr } = useMemo(() => {
    if (file) return { md: file.text, renderErr: null };
    if (!state) return { md: "", renderErr: null };
    try {
      return { md: mode === "plan" ? planMarkdown(state) : finalMarkdown(state), renderErr: null };
    } catch (e) {
      return { md: "", renderErr: `Could not render this session: ${(e as Error).message}` };
    }
  }, [file, state, mode]);
  // Safe for dangerouslySetInnerHTML ONLY because md-html escapes every piece of text.
  const body = useMemo(() => (md ? reportBodyHtml(md) : ""), [md]);
  const title = file ? file.name.replace(ACCEPT, "") || "Plan report" : "SceneBnao plan";

  function readFile(f: File | null | undefined) {
    if (!f) return;
    if (!ACCEPT.test(f.name)) return setErr(`"${f.name}" is not a .md or .txt file.`);
    if (f.size > MAX_BYTES) return setErr(`"${f.name}" is larger than 10 MB.`);
    const r = new FileReader();
    r.onload = () => {
      setFile({ name: f.name, text: String(r.result ?? "") });
      setErr(null);
    };
    r.onerror = () => setErr(`Could not read "${f.name}".`);
    r.readAsText(f);
  }

  function downloadHtml() {
    if (!md) return;
    const blob = new Blob([reportHtml(md, title)], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = file ? `${title.replace(/[^\w.-]+/g, "-")}.html` : mode === "plan" ? "scenebnao-plan.html" : "scenebnao-plan-and-trace.html";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const shownErr = err ?? renderErr;
  const btn = "rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-100 disabled:opacity-40";

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 print:max-w-none print:p-0">
      <style dangerouslySetInnerHTML={{ __html: REPORT_CSS }} />

      <div className="print:hidden">
        <Link href="/" className="text-sm font-semibold text-indigo-700 hover:underline">
          ← Dashboard
        </Link>
        <header className="mb-4 mt-2">
          <h1 className="text-2xl font-black tracking-tight text-slate-900">Plan report</h1>
          <p className="text-sm text-slate-600">
            Read the generated plan as a clean, formatted page. Pick a saved session, or drop a plan file (<code className="rounded bg-slate-100 px-1">.md</code> / <code className="rounded bg-slate-100 px-1">.txt</code>). Grey chips show which messages each figure came from.
          </p>
        </header>

        <div className="mb-4 grid gap-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm md:grid-cols-2">
          <div className="space-y-3">
            <div>
              <label htmlFor="report-session" className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
                Session
              </label>
              <select id="report-session" className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 disabled:opacity-50" value={sid} disabled={!!file || sessions.length === 0} onChange={(e) => setSid(e.target.value)}>
                {sessions.length === 0 && <option value="">No sessions yet</option>}
                {sessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.source === "cli" ? "CLI · " : "Web · "}
                    {s.label || s.id.slice(0, 8)} · {new Date(s.updated_at).toLocaleString()}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Show</div>
              <div className="inline-flex overflow-hidden rounded-lg border border-slate-300" role="group" aria-label="What to show">
                {(
                  [
                    ["plan", "Plan only"],
                    ["full", "Plan + trace"],
                  ] as [Mode, string][]
                ).map(([k, label]) => (
                  <button key={k} type="button" aria-pressed={mode === k} disabled={!!file} onClick={() => setMode(k)} className={`px-3 py-1.5 text-sm font-semibold disabled:opacity-40 ${mode === k ? "bg-slate-900 text-white" : "bg-white text-slate-700 hover:bg-slate-100"}`}>
                    {label}
                  </button>
                ))}
              </div>
              {file && <p className="mt-1 text-xs text-slate-500">Showing an uploaded file — clear it to switch back to sessions.</p>}
            </div>
          </div>

          <div
            role="button"
            tabIndex={0}
            onClick={() => inputRef.current?.click()}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), inputRef.current?.click())}
            onDragOver={(e) => {
              e.preventDefault();
              setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDrag(false);
              readFile(e.dataTransfer.files?.[0]);
            }}
            className={`flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-4 text-center text-sm transition-colors ${drag ? "border-indigo-500 bg-indigo-50 text-indigo-900" : "border-slate-300 bg-slate-50 text-slate-600 hover:border-slate-400"}`}
          >
            <span className="font-semibold text-slate-800">{file ? file.name : "Drop a .md or .txt file here"}</span>
            <span className="text-xs">{file ? `${file.text.length.toLocaleString()} characters · click or drop to replace` : "or click to choose a file"}</span>
            <input
              ref={inputRef}
              type="file"
              accept=".md,.markdown,.txt,text/markdown,text/plain"
              className="hidden"
              onChange={(e) => {
                readFile(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </div>
        </div>

        <div className="mb-4 flex flex-wrap items-center gap-2">
          <button type="button" className={btn} disabled={!md} onClick={() => window.print()}>
            Print / Save as PDF
          </button>
          <button type="button" className={btn} disabled={!md} onClick={downloadHtml}>
            Download .html
          </button>
          {file && (
            <button type="button" className={btn} onClick={() => setFile(null)}>
              Clear file
            </button>
          )}
          {busy && !file && <span className="text-sm text-slate-500">Loading…</span>}
        </div>

        {shownErr && <p className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-800">{shownErr}</p>}
      </div>

      <article className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm sm:p-10 print:rounded-none print:border-0 print:p-0 print:shadow-none">
        {body ? <div dangerouslySetInnerHTML={{ __html: body }} /> : <p className="text-sm text-slate-500">{busy && !file ? "Loading…" : "Nothing to show yet — pick a session or drop a plan file."}</p>}
      </article>
    </div>
  );
}
