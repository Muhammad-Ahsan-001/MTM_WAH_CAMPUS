"use client";

import type { KitInputs as Inputs, Lang } from "../../src/extras/messages";

export default function KitInputs({ value, onChange, deadlineHint }: { value: Inputs; onChange: (v: Inputs) => void; deadlineHint: string }) {
  const set = (k: keyof Inputs, v: string) => onChange({ ...value, [k]: v });
  const langs: [Lang, string][] = [
    ["en", "English"],
    ["ur", "Roman Urdu"],
    ["both", "Both"],
  ];
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="mb-3 text-sm font-semibold text-slate-900">Inputs (saved in this browser for this session)</h2>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="block text-sm">
          <span className="font-medium text-slate-700">Google Form link (repo submission)</span>
          <input className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-slate-900" placeholder="https://forms.gle/…" value={value.formLink} onChange={(e) => set("formLink", e.target.value)} />
        </label>
        <label className="block text-sm">
          <span className="font-medium text-slate-700">Location / directions (optional, blank hides it)</span>
          <input className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-slate-900" placeholder="Building, floor, landmark" value={value.location} onChange={(e) => set("location", e.target.value)} />
        </label>
        <label className="block text-sm">
          <span className="font-medium text-slate-700">Repo deadline</span>
          <input className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-slate-900" placeholder={deadlineHint ? `${deadlineHint} (build end)` : "build end"} value={value.deadline} onChange={(e) => set("deadline", e.target.value)} />
        </label>
        <div className="text-sm">
          <span className="font-medium text-slate-700">Language</span>
          <div className="mt-1 inline-flex overflow-hidden rounded-lg border border-slate-300">
            {langs.map(([k, l]) => (
              <button key={k} type="button" onClick={() => set("lang", k)} className={`px-3 py-2 ${value.lang === k ? "bg-slate-900 text-white" : "bg-white text-slate-700 hover:bg-slate-100"}`}>
                {l}
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
