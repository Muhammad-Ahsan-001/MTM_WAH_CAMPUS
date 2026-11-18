"use client";
// Popover for "Explain this number": formula with values, source messages, and the history of overridden messages.
import { useEffect } from "react";
import type { Explanation } from "../../src/extras/explain";

const CHIP: Record<string, string> = {
  superseded: "bg-amber-100 text-amber-800",
  rejected: "bg-red-100 text-red-800",
  needs_decision: "bg-violet-100 text-violet-800",
  duplicate: "bg-slate-200 text-slate-700",
};

export default function Explain({ ex, onClose }: { ex: Explanation; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/30 p-4" onClick={onClose} role="presentation">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={ex.title}
        className="max-h-[85vh] w-full max-w-xl overflow-auto rounded-xl bg-white p-5 text-slate-800 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <h3 className="text-base font-bold text-slate-900">{ex.title}</h3>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded px-2 text-lg leading-none text-slate-500 hover:bg-slate-100 hover:text-slate-900">
            ×
          </button>
        </div>
        <div className="mb-4 rounded-lg bg-slate-50 p-3 font-mono text-[12px] leading-relaxed text-slate-800">
          {ex.formula.map((l, i) => (
            <div key={i} className="whitespace-pre-wrap">
              {l}
            </div>
          ))}
        </div>
        <div className="mb-4 text-sm">
          <span className="mr-2 font-semibold text-slate-500">From messages:</span>
          {ex.refs.length ? (
            ex.refs.map((r) => (
              <span key={r} className="mr-1 inline-block rounded bg-sky-100 px-1.5 py-0.5 font-mono text-[11px] text-sky-800">
                {r}
              </span>
            ))
          ) : (
            <span className="text-slate-400">none (policy default)</span>
          )}
        </div>
        {ex.history.length > 0 && (
          <div className="text-sm">
            <div className="mb-1 font-semibold text-slate-500">History</div>
            <ul className="space-y-1">
              {ex.history.map((h, i) => (
                <li key={`${h.ref}-${i}`} className="flex items-start gap-2">
                  <span className="font-mono text-[11px] text-slate-600">{h.ref}</span>
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${CHIP[h.status] ?? "bg-slate-100 text-slate-700"}`}>{h.status.replace("_", " ")}</span>
                  <span className="text-slate-700">{h.reason}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
