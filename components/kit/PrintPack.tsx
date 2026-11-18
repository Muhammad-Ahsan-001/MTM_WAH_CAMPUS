"use client";

import QRCode from "qrcode";
import { useEffect, useMemo, useState } from "react";
import type { SessionState } from "../../src/core/types";
import { clock, planTeams, type KitInputs, type SeatTeam } from "../../src/extras/messages";

const rs = (n: number) => `Rs ${Math.round(n).toLocaleString("en-US")}`;

function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

function Sheet({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <section className="kit-sheet rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="text-lg font-bold text-slate-900">{title}</h2>
      {sub && <p className="mb-3 text-sm text-slate-600">{sub}</p>}
      {children}
    </section>
  );
}

function AttendanceTable({ teams }: { teams: SeatTeam[] }) {
  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr className="border-b-2 border-slate-800 text-left">
          <th className="py-1 pr-2">Team</th>
          <th className="py-1 pr-2">Name</th>
          <th className="py-1 pr-2">Table</th>
          <th className="py-1 pr-2">Size</th>
          <th className="py-1 pr-2">Member</th>
          <th className="w-20 py-1 pr-2">Check-in</th>
          <th className="w-32 py-1">Signature</th>
        </tr>
      </thead>
      <tbody>
        {teams.map((t) =>
          Array.from({ length: Math.max(1, t.size) }, (_, i) => (
            <tr key={`${t.id}-${i}`} className={`border-b ${i === Math.max(1, t.size) - 1 ? "border-slate-500" : "border-slate-200"}`}>
              <td className="py-1.5 pr-2 font-semibold">{i === 0 ? t.id : ""}</td>
              <td className="py-1.5 pr-2">{i === 0 ? t.name : ""}</td>
              <td className="py-1.5 pr-2">{i === 0 ? (t.table ?? "") : ""}</td>
              <td className="py-1.5 pr-2">{i === 0 ? t.size : ""}</td>
              <td className="py-1.5 pr-2">{t.members[i] ?? `${i + 1}. ____________________`}</td>
              <td className="py-1.5 pr-2">____</td>
              <td className="py-1.5">______________</td>
            </tr>
          )),
        )}
      </tbody>
    </table>
  );
}

export default function PrintPack({ state, inputs, seats }: { state: SessionState; inputs: KitInputs; seats: SeatTeam[] | null }) {
  const plan = state.plan;
  const [qr, setQr] = useState<string | null>(null);
  const link = inputs.formLink.trim();

  useEffect(() => {
    let alive = true;
    if (!link) {
      setQr(null);
      return;
    }
    QRCode.toDataURL(link, { margin: 1, width: 240 })
      .then((u) => alive && setQr(u))
      .catch(() => alive && setQr(null));
    return () => {
      alive = false;
    };
  }, [link]);

  const teams = useMemo<SeatTeam[]>(() => (seats && seats.length ? seats : plan ? planTeams(plan) : []), [seats, plan]);
  const fromSeating = !!(seats && seats.length);
  const rooms = useMemo(() => {
    const m = new Map<string, SeatTeam[]>();
    for (const t of teams) {
      const r = t.room ?? plan?.venue?.rooms[0]?.name ?? "Room";
      if (!m.has(r)) m.set(r, []);
      m.get(r)!.push(t);
    }
    for (const list of m.values()) list.sort((a, b) => (a.table ?? 1e9) - (b.table ?? 1e9) || a.id.localeCompare(b.id));
    return [...m.entries()];
  }, [teams, plan]);

  if (!plan) return <p className="text-sm text-slate-600">No plan yet for this session.</p>;
  const roomOf = (t: SeatTeam) => t.room ?? plan.venue?.rooms[0]?.name ?? "";

  return (
    <div className="space-y-4">
      <div className="kit-noprint flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <button type="button" onClick={() => window.print()} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700">
          Print Event Kit
        </button>
        <span className="text-sm text-slate-600">
          A4 · {teams.length} teams from {fromSeating ? "the seating roster" : "the plan (no seating roster saved yet)"}
          {!link && " · add the Google Form link in Group messages to put a QR on each patch"}
        </span>
      </div>

      <Sheet title="Event Kit — plan summary" sub={state.label || state.id}>
        <div className="grid gap-x-8 gap-y-1 text-sm md:grid-cols-2">
          <p>Participants: <b>{plan.event.participants}</b> · Teams: <b>{plan.event.teams}</b>{plan.event.team_size ? ` × ${plan.event.team_size}` : ""}</p>
          <p>People on site: <b>{plan.event.people_on_site}</b> · To feed: <b>{plan.event.people_to_feed}</b></p>
          <p>Venue: <b>{plan.venue?.rooms.map((r) => r.name).join(", ") ?? "—"}</b>{plan.venue ? ` (capacity ${plan.venue.capacity})` : ""}</p>
          <p>Food: <b>{plan.food ? `${plan.food.tier.replace(/_/g, " ")} × ${plan.food.quantity}` : "—"}</b></p>
          <p>Judging: <b>{plan.judging ? `${plan.judging.judges_used} judges · ${plan.judging.minutes_per_team} min/team · ${plan.judging.judges_per_team}/team` : "—"}</b></p>
          <p>Budget: <b>{plan.budget ? `${rs(plan.budget.total)}${plan.budget.remaining !== null ? ` · remaining ${rs(plan.budget.remaining)}` : ""}` : "—"}</b></p>
        </div>
        {plan.schedule && (
          <table className="mt-3 w-full border-collapse text-sm">
            <tbody>
              {plan.schedule.blocks.map((b, i) => (
                <tr key={i} className="border-b border-slate-200">
                  <td className="w-36 py-1 font-mono">{clock(plan, b.start)}–{clock(plan, b.start + b.minutes)}</td>
                  <td className="py-1">{b.label.replace(/_/g, " ")}</td>
                  <td className="py-1 text-right text-slate-600">{b.minutes} min</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Sheet>

      <Sheet title="Door attendance sheet" sub="Every team · one line per seat · tick check-in time and sign">
        <AttendanceTable teams={[...teams].sort((a, b) => a.id.localeCompare(b.id))} />
      </Sheet>

      {rooms.map(([room, list]) => (
        <Sheet key={room} title={`Room attendance — ${room}`} sub={`${list.length} teams · ordered by table number`}>
          <AttendanceTable teams={list} />
        </Sheet>
      ))}

      {chunk(teams, 8).map((page, pi) => (
        <section key={pi} className="kit-sheet">
          <h2 className="kit-noprint mb-2 text-sm font-semibold text-slate-700">Table / chair patches · page {pi + 1}</h2>
          <div className="kit-patches grid grid-cols-2 gap-2">
            {page.map((t) => (
              <div key={t.id} className="kit-patch flex items-center justify-between gap-3 rounded-xl border-2 border-dashed border-slate-400 bg-white p-4">
                <div className="min-w-0">
                  <div className="text-5xl font-black leading-none text-slate-900">{t.id}</div>
                  <div className="mt-2 text-lg font-semibold text-slate-800">{t.table !== null ? `Table ${t.table}` : "Table —"}</div>
                  <div className="text-sm text-slate-700">{roomOf(t)}</div>
                  <div className="truncate text-sm text-slate-600">{t.name}</div>
                </div>
                {qr ? (
                  <div className="text-center">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={qr} alt="Repo submission form QR" className="h-28 w-28" />
                    <div className="text-[10px] text-slate-600">Scan to submit repo</div>
                  </div>
                ) : (
                  <div className="w-28 text-center text-xs text-slate-500">Add the Google Form link to show a QR here</div>
                )}
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
