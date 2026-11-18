"use client";

import { useState } from "react";
import type { SessionState } from "../../src/core/types";
import { broadcasts, budgetMsg, judgingMsg, lunchMsg, repoMsg, scheduleMsg, venueMsg, waLink, type KitInputs, type SeatTeam } from "../../src/extras/messages";

function Card({ title, text, tag }: { title: string; text: string; tag?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  };
  return (
    <div className="flex flex-col rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-900">
          {title} {tag && <span className="ml-1 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800">{tag}</span>}
        </h3>
        <div className="flex gap-2">
          <button type="button" onClick={copy} className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100">
            {copied ? "Copied" : "Copy"}
          </button>
          <a href={waLink(text)} target="_blank" rel="noreferrer" className="rounded-lg bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-700">
            Open in WhatsApp
          </a>
        </div>
      </div>
      <pre className="flex-1 whitespace-pre-wrap rounded-lg bg-slate-50 p-3 font-sans text-sm leading-relaxed text-slate-800">{text}</pre>
    </div>
  );
}

export default function Messages({ state, inputs, seats }: { state: SessionState; inputs: KitInputs; seats: SeatTeam[] | null }) {
  const plan = state.plan;
  const [showOld, setShowOld] = useState(false);
  if (!plan) return <p className="text-sm text-slate-600">No plan yet for this session.</p>;
  const lang = inputs.lang;
  const bc = broadcasts(state, lang);
  const [latest, ...older] = bc;
  return (
    <div className="space-y-4">
      <section className="rounded-xl border-2 border-sky-300 bg-sky-50 p-4">
        <h2 className="mb-2 text-sm font-semibold text-sky-900">Update broadcast {latest ? `· batch ${latest.batch}` : ""}</h2>
        {!latest && <p className="text-sm text-slate-700">Only the first batch so far. An update message is drafted automatically from the plan diff when the next batch arrives.</p>}
        {latest?.text && <Card title={`Update from batch ${latest.batch}`} text={latest.text} />}
        {latest?.blocked && <p className="rounded-lg border border-rose-200 bg-white p-3 text-sm font-medium text-rose-800">{latest.blocked}</p>}
        {older.length > 0 && (
          <div className="mt-3">
            <button type="button" onClick={() => setShowOld((s) => !s)} className="text-sm font-medium text-sky-800 underline">
              {showOld ? "Hide" : "Show"} earlier broadcasts ({older.length})
            </button>
            {showOld && (
              <div className="mt-2 space-y-2">
                {older.map((b) =>
                  b.text ? <Card key={b.batch} title={`Batch ${b.batch}`} text={b.text} /> : <p key={b.batch} className="rounded-lg border border-slate-200 bg-white p-3 text-sm text-slate-700">Batch {b.batch}: {b.blocked}</p>,
                )}
              </div>
            )}
          </div>
        )}
      </section>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="1 · Schedule" text={scheduleMsg(plan, lang)} />
        <Card title="2 · Venue & seating" text={venueMsg(plan, lang, inputs.location, seats)} />
        <Card title="3 · Lunch" text={lunchMsg(plan, lang)} />
        <Card title="4 · Judging guidelines" text={judgingMsg(plan, lang)} />
        <Card title="5 · Repo submission" text={repoMsg(plan, lang, inputs.formLink, inputs.deadline)} />
        <Card title="6 · Budget / ops summary" tag="organizers only" text={budgetMsg(plan)} />
      </div>
    </div>
  );
}
