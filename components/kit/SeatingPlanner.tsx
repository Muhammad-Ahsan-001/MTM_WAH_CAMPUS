"use client";

import { useEffect, useMemo, useState } from "react";
import type { SessionState } from "../../src/core/types";
import {
  allocate,
  countsFromPlan,
  defaultRoom,
  formatRoom,
  mixedRoom,
  parseLayout,
  parseRoster,
  teamId,
  teamsFromCounts,
  toExport,
  type Allocation,
  type RoomSpec,
  type Team,
  type TeamCounts,
  type Unit,
} from "../../src/extras/seating2d";

interface SavedInput {
  counts: TeamCounts;
  roster: string;
  teams: Team[];
  layout: string;
}

const COLORS = {
  trio: { fill: "#e0e7ff", stroke: "#6366f1", text: "#3730a3" },
  duo: { fill: "#ccfbf1", stroke: "#14b8a6", text: "#115e59" },
  solo: { fill: "#fef3c7", stroke: "#f59e0b", text: "#92400e" },
  merged: { fill: "url(#seat-stripes)", stroke: "#db2777", text: "#831843" },
  empty: { fill: "#f1f5f9", stroke: "#cbd5e1", text: "#94a3b8" },
};

function load<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
function save(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}

function planLayout(state: SessionState, mixed: boolean): string {
  const rooms = state.plan?.venue?.rooms ?? [];
  if (!rooms.length) return "";
  return rooms.map((r) => formatRoom(mixed ? mixedRoom(r.name, r.capacity) : defaultRoom(r.name, r.capacity))).join("\n");
}

function planCounts(state: SessionState): TeamCounts {
  const ev = state.plan?.event;
  if (!ev) return { trio: 0, duo: 0, solo: 0 };
  return countsFromPlan(ev.participants, ev.teams, ev.team_size);
}

export default function SeatingPlanner({ sid, state }: { sid: string; state: SessionState }) {
  const inputKey = `kit:${sid}:seating-input`;
  const outKey = `kit:${sid}:seating`;
  const [loaded, setLoaded] = useState(false);
  const [counts, setCounts] = useState<TeamCounts>(() => planCounts(state));
  const [roster, setRoster] = useState("");
  const [teams, setTeams] = useState<Team[]>(() => teamsFromCounts(planCounts(state)));
  const [layout, setLayout] = useState(() => planLayout(state, false));
  const [rosterMsg, setRosterMsg] = useState<string[]>([]);

  // restore saved inputs (client only)
  useEffect(() => {
    const s = load<SavedInput>(inputKey);
    if (s) {
      if (s.counts) setCounts(s.counts);
      if (typeof s.roster === "string") setRoster(s.roster);
      if (Array.isArray(s.teams)) setTeams(s.teams);
      if (typeof s.layout === "string") setLayout(s.layout);
    }
    setLoaded(true);
  }, [inputKey]);

  useEffect(() => {
    if (loaded) save(inputKey, { counts, roster, teams, layout } satisfies SavedInput);
  }, [loaded, inputKey, counts, roster, teams, layout]);

  const parsed = useMemo(() => parseLayout(layout), [layout]);
  const alloc = useMemo<Allocation>(() => allocate(parsed.rooms, teams), [parsed.rooms, teams]);

  useEffect(() => {
    if (loaded) save(outKey, toExport(teams, alloc));
  }, [loaded, outKey, teams, alloc]);

  const byTeam = useMemo(() => new Map(teams.map((t) => [t.id, t])), [teams]);

  const applyCounts = () => setTeams(teamsFromCounts(counts));
  const applyRoster = () => {
    const r = parseRoster(roster);
    setRosterMsg(r.errors.map((e) => e.message));
    if (r.teams.length) {
      setTeams(r.teams);
      setCounts({
        trio: r.teams.filter((t) => t.size >= 3).length,
        duo: r.teams.filter((t) => t.size === 2).length,
        solo: r.teams.filter((t) => t.size === 1).length,
      });
    } else if (!r.errors.length) setRosterMsg(["No roster lines found."]);
  };
  const updateTeam = (i: number, patch: Partial<Team>) =>
    setTeams((ts) => ts.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  const removeTeam = (i: number) => setTeams((ts) => ts.filter((_, j) => j !== i).map((t, j) => ({ ...t, id: teamId(j) })));
  const addTeam = () =>
    setTeams((ts) => [...ts, { id: teamId(ts.length), name: `Team ${teamId(ts.length).slice(1)}`, size: 3, members: [] }]);

  const people = teams.reduce((a, t) => a + t.size, 0);
  const card = "rounded-xl border border-slate-200 bg-white p-4 shadow-sm";
  const btn = "rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50";
  const btnPrimary = "rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700";

  return (
    <div className="seating-planner space-y-4 text-slate-800">
      <style>{`
        @media print {
          body * { visibility: hidden !important; }
          .seating-planner .seating-print, .seating-planner .seating-print * { visibility: visible !important; }
          .seating-planner .seating-print { position: absolute; left: 0; top: 0; width: 100%; }
          .seating-planner .no-print { display: none !important; }
          .seating-planner .seating-room { break-inside: avoid; page-break-inside: avoid; }
          .seating-planner svg { max-width: 100%; height: auto; }
        }
      `}</style>

      <div className="no-print grid gap-4 lg:grid-cols-2">
        {/* Team roster */}
        <section className={card}>
          <h3 className="mb-2 text-base font-semibold text-slate-900">Team roster</h3>
          <p className="mb-3 text-xs text-slate-500">
            Prefilled from the plan ({state.plan?.event.participants ?? 0} participants, {state.plan?.event.teams ?? 0} teams
            {state.plan?.event.team_size ? ` of ${state.plan.event.team_size}` : ""}). {teams.length} teams · {people} people.
          </p>
          <div className="mb-3 flex flex-wrap items-end gap-3">
            {(["trio", "duo", "solo"] as const).map((k) => (
              <label key={k} className="text-xs text-slate-600">
                {k}
                <input
                  type="number"
                  min={0}
                  value={counts[k]}
                  onChange={(e) => setCounts({ ...counts, [k]: Math.max(0, parseInt(e.target.value || "0", 10) || 0) })}
                  className="mt-1 block w-20 rounded-md border border-slate-300 px-2 py-1 text-sm"
                />
              </label>
            ))}
            <button className={btn} onClick={applyCounts}>
              Apply counts
            </button>
            <button
              className={btn}
              onClick={() => {
                const c = planCounts(state);
                setCounts(c);
                setTeams(teamsFromCounts(c));
              }}
            >
              Reset from plan
            </button>
          </div>
          <label className="text-xs text-slate-600">
            Paste roster — one line per team: <code>Team name | member1, member2, …</code>
          </label>
          <textarea
            value={roster}
            onChange={(e) => setRoster(e.target.value)}
            rows={4}
            placeholder={"Code Crushers | Ana, Bilal, Chen\nSolo Sam | Sam"}
            className="mt-1 w-full rounded-md border border-slate-300 p-2 font-mono text-xs"
          />
          <div className="mt-2 flex items-center gap-2">
            <button className={btn} onClick={applyRoster}>
              Use roster
            </button>
            {rosterMsg.length > 0 && <span className="text-xs text-amber-700">{rosterMsg.join(" · ")}</span>}
          </div>
          <details className="mt-3">
            <summary className="cursor-pointer text-sm font-medium text-slate-700">Edit teams ({teams.length})</summary>
            <div className="mt-2 max-h-72 overflow-auto">
              <table className="w-full text-xs">
                <thead className="text-left text-slate-500">
                  <tr>
                    <th className="py-1 pr-2">ID</th>
                    <th className="pr-2">Name</th>
                    <th className="pr-2">Size</th>
                    <th className="pr-2">Members (comma)</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {teams.map((t, i) => (
                    <tr key={t.id + i} className="border-t border-slate-100">
                      <td className="py-1 pr-2 font-mono">{t.id}</td>
                      <td className="pr-2">
                        <input value={t.name} onChange={(e) => updateTeam(i, { name: e.target.value })} className="w-32 rounded border border-slate-200 px-1" />
                      </td>
                      <td className="pr-2">
                        <input
                          type="number"
                          min={1}
                          value={t.size}
                          onChange={(e) => updateTeam(i, { size: Math.max(1, parseInt(e.target.value || "1", 10) || 1) })}
                          className="w-14 rounded border border-slate-200 px-1"
                        />
                      </td>
                      <td className="pr-2">
                        <input
                          value={t.members.join(", ")}
                          onChange={(e) => {
                            const members = e.target.value.split(",").map((m) => m.trim());
                            const named = members.filter(Boolean);
                            updateTeam(i, { members, size: named.length > t.size ? named.length : t.size });
                          }}
                          onBlur={() => updateTeam(i, { members: t.members.filter(Boolean) })}
                          className="w-full rounded border border-slate-200 px-1"
                        />
                      </td>
                      <td>
                        <button className="text-slate-400 hover:text-red-600" onClick={() => removeTeam(i)} title="Remove team">
                          ×
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button className={`${btn} mt-2`} onClick={addTeam}>
              + Add team
            </button>
          </details>
        </section>

        {/* Layout */}
        <section className={card}>
          <h3 className="mb-2 text-base font-semibold text-slate-900">Room layout</h3>
          <p className="mb-2 text-xs text-slate-500">
            One line per room: <code>Room: &lt;name&gt; | capacity: &lt;n&gt; | front: north|south|east|west | grid: &lt;rows&gt;x&lt;cols&gt; | trio: &lt;n&gt; | duo: &lt;n&gt; | solo: &lt;n&gt;</code>
          </p>
          <textarea
            value={layout}
            onChange={(e) => setLayout(e.target.value)}
            rows={6}
            placeholder="Room: Main hall | capacity: 120 | front: north | grid: 7x6 | trio: 40"
            className="w-full rounded-md border border-slate-300 p-2 font-mono text-xs"
          />
          <div className="mt-2 flex flex-wrap gap-2">
            <button className={btn} onClick={() => setLayout(planLayout(state, false))} disabled={!state.plan?.venue?.rooms.length}>
              Insert layout from plan
            </button>
            <button className={btn} onClick={() => setLayout(planLayout(state, true))} disabled={!state.plan?.venue?.rooms.length}>
              Insert mixed example
            </button>
          </div>
          {!state.plan?.venue?.rooms.length && <p className="mt-2 text-xs text-slate-500">The plan has no chosen room yet — type a layout line.</p>}
          {parsed.issues.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-xs">
              {parsed.issues.map((e, i) => (
                <li key={i} className={e.error ? "text-red-600" : "text-amber-700"}>
                  {e.message}
                </li>
              ))}
            </ul>
          )}
          {parsed.rooms.length > 0 && (
            <p className="mt-2 text-xs text-slate-500">
              Parsed {parsed.rooms.length} room{parsed.rooms.length === 1 ? "" : "s"}:{" "}
              {parsed.rooms.map((r) => `${r.name} (${r.rows}x${r.cols}, ${r.trio}T/${r.duo}D/${r.solo}S)`).join(", ")}
            </p>
          )}
        </section>
      </div>

      {/* Result */}
      <section className={`${card} seating-print`}>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-base font-semibold text-slate-900">Seating plan</h3>
          <button className={`${btnPrimary} no-print`} onClick={() => window.print()}>
            Print
          </button>
        </div>
        <Stats alloc={alloc} teams={teams} />
        {alloc.unseated.length > 0 && (
          <div className="my-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            <strong>
              {alloc.unseated.length} team{alloc.unseated.length === 1 ? "" : "s"} unseated ({alloc.shortfall} people)
            </strong>
            {alloc.seatGap > 0 ? ` — short by ${alloc.seatGap} seats overall. ` : " — "}
            {alloc.unseated.map((t) => `${t.id} (${t.size})`).join(", ")}
          </div>
        )}
        <Legend />
        {parsed.rooms.length === 0 && <p className="text-sm text-slate-500">Add a room layout to see the plan.</p>}
        <div className="space-y-4">
          {parsed.rooms.map((r, ri) => (
            <RoomSvg key={ri} room={r} roomIndex={ri} alloc={alloc} byTeam={byTeam} />
          ))}
        </div>
        {(alloc.merges.length > 0 || alloc.notes.length > 0) && (
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div>
              <h4 className="mb-1 text-sm font-semibold text-slate-800">Merges ({alloc.merges.length})</h4>
              <ul className="max-h-60 space-y-0.5 overflow-auto text-xs text-slate-600">
                {alloc.merges.map((m, i) => (
                  <li key={i}>{m}</li>
                ))}
              </ul>
            </div>
            <div>
              <h4 className="mb-1 text-sm font-semibold text-slate-800">Notes</h4>
              <ul className="max-h-60 space-y-0.5 overflow-auto text-xs text-slate-600">
                {alloc.notes.map((m, i) => (
                  <li key={i}>{m}</li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function Stats({ alloc, teams }: { alloc: Allocation; teams: Team[] }) {
  const emptyUnits = alloc.units.length - new Set(alloc.placements.flatMap((p) => p.units)).size;
  const items: [string, string, string?][] = [
    ["Seats used", `${alloc.seatsUsed} / ${alloc.seatsTotal}`],
    ["Teams seated", `${teams.length - alloc.unseated.length} / ${teams.length}`],
    ["Merges", String(alloc.merges.length)],
    ["Empty seats", `${alloc.emptySeats} (${emptyUnits} empty units)`],
    ["Overflow", alloc.shortfall ? `${alloc.shortfall} people` : "none", alloc.shortfall ? "text-red-600" : undefined],
  ];
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
      {items.map(([k, v, cls]) => (
        <div key={k} className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2">
          <div className="text-[11px] uppercase tracking-wide text-slate-500">{k}</div>
          <div className={`text-sm font-semibold ${cls ?? "text-slate-900"}`}>{v}</div>
        </div>
      ))}
    </div>
  );
}

function Swatch({ kind }: { kind: keyof typeof COLORS }) {
  const c = COLORS[kind];
  return (
    <svg width="18" height="12" aria-hidden>
      <defs>
        <StripePattern id="seat-stripes-legend" />
      </defs>
      <rect x="0.5" y="0.5" width="17" height="11" rx="2" fill={kind === "merged" ? "url(#seat-stripes-legend)" : c.fill} stroke={c.stroke} />
    </svg>
  );
}

function StripePattern({ id }: { id: string }) {
  return (
    <pattern id={id} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="6" height="6" fill="#fce7f3" />
      <line x1="0" y1="0" x2="0" y2="6" stroke="#f472b6" strokeWidth="3" />
    </pattern>
  );
}

function Legend() {
  const items: [keyof typeof COLORS, string][] = [
    ["trio", "Trio table (3)"],
    ["duo", "Duo desk (2)"],
    ["solo", "Solo desk (1)"],
    ["merged", "Merged units"],
    ["empty", "Empty"],
  ];
  return (
    <div className="my-3 flex flex-wrap gap-4 text-xs text-slate-600">
      {items.map(([k, l]) => (
        <span key={k} className="inline-flex items-center gap-1.5">
          <Swatch kind={k} />
          {l}
        </span>
      ))}
    </div>
  );
}

const CW = 74; // cell width
const CH = 50; // cell height
const GAP = 8;
const BAR = 26;
const PAD = 14;

function RoomSvg({ room, roomIndex, alloc, byTeam }: { room: RoomSpec; roomIndex: number; alloc: Allocation; byTeam: Map<string, Team> }) {
  const units = alloc.units.filter((u) => u.roomIndex === roomIndex);
  const placementOf = new Map<string, (typeof alloc.placements)[number]>();
  for (const p of alloc.placements) for (const k of p.units) placementOf.set(k, p);
  const gridW = room.cols * CW + (room.cols - 1) * GAP;
  const gridH = room.rows * CH + (room.rows - 1) * GAP;
  const vertical = room.front === "north" || room.front === "south";
  const offX = PAD + (room.front === "west" ? BAR + GAP : 0);
  const offY = PAD + (room.front === "north" ? BAR + GAP : 0);
  const W = gridW + PAD * 2 + (vertical ? 0 : BAR + GAP);
  const H = gridH + PAD * 2 + (vertical ? BAR + GAP : 0);
  const bar =
    room.front === "north"
      ? { x: PAD, y: PAD, w: gridW, h: BAR }
      : room.front === "south"
        ? { x: PAD, y: H - PAD - BAR, w: gridW, h: BAR }
        : room.front === "west"
          ? { x: PAD, y: PAD, w: BAR, h: gridH }
          : { x: W - PAD - BAR, y: PAD, w: BAR, h: gridH };
  const used = units.filter((u) => placementOf.has(u.key));
  const seats = units.reduce((a, u) => a + u.seats, 0);
  const usedSeats = alloc.placements
    .filter((p) => p.units.some((k) => k.startsWith(`${roomIndex}:`)))
    .reduce((a, p) => a + (byTeam.get(p.team)?.size ?? 0), 0);
  const pos = (u: Unit) => ({ x: offX + u.col * (CW + GAP), y: offY + u.row * (CH + GAP) });

  // merge connectors between units of the same placement
  const links: { x1: number; y1: number; x2: number; y2: number }[] = [];
  for (const p of alloc.placements) {
    if (!p.merged) continue;
    const us = p.units.map((k) => units.find((u) => u.key === k)).filter((u): u is Unit => !!u);
    for (let i = 1; i < us.length; i++) {
      const a = pos(us[i - 1]);
      const b = pos(us[i]);
      links.push({ x1: a.x + CW / 2, y1: a.y + CH / 2, x2: b.x + CW / 2, y2: b.y + CH / 2 });
    }
  }

  return (
    <div className="seating-room">
      <div className="mb-1 flex flex-wrap items-baseline gap-3">
        <h4 className="text-sm font-semibold text-slate-800">{room.name}</h4>
        <span className="text-xs text-slate-500">
          capacity {room.capacity} · {seats} seats · {usedSeats} used · {units.length - used.length} empty units · front: {room.front}
        </span>
      </div>
      <div className="overflow-x-auto">
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Seating plan for ${room.name}`} style={{ fontFamily: "ui-sans-serif, system-ui, sans-serif" }}>
          <defs>
            <StripePattern id="seat-stripes" />
          </defs>
          <rect x="1" y="1" width={W - 2} height={H - 2} rx="10" fill="#ffffff" stroke="#94a3b8" strokeWidth="2" />
          <rect x={bar.x} y={bar.y} width={bar.w} height={bar.h} rx="4" fill="#1e293b" />
          <text
            x={bar.x + bar.w / 2}
            y={bar.y + bar.h / 2}
            fill="#ffffff"
            fontSize="11"
            fontWeight="600"
            textAnchor="middle"
            dominantBaseline="central"
            letterSpacing="2"
            transform={vertical ? undefined : `rotate(${room.front === "west" ? -90 : 90} ${bar.x + bar.w / 2} ${bar.y + bar.h / 2})`}
          >
            FRONT / STAGE
          </text>
          {links.map((l, i) => (
            <line key={i} {...l} stroke="#db2777" strokeWidth="4" strokeLinecap="round" opacity="0.5" />
          ))}
          {units.map((u) => {
            const p = placementOf.get(u.key);
            const t = p ? byTeam.get(p.team) : undefined;
            const c = !p ? COLORS.empty : p.merged ? COLORS.merged : COLORS[u.kind];
            const { x, y } = pos(u);
            const title = p
              ? `${p.team} · ${t?.name ?? ""} — ${t?.members.filter(Boolean).length ? t.members.filter(Boolean).join(", ") : `${t?.size ?? "?"} people`}\nTable ${p.table} · ${p.unit}${p.merged ? " (merged)" : ""}${p.empty ? ` · ${p.empty} empty seat${p.empty === 1 ? "" : "s"}` : ""}`
              : `Empty ${u.kind} ${u.kind === "trio" ? "table" : "desk"} ${u.code} (table ${u.number}, ${u.seats} seat${u.seats === 1 ? "" : "s"})`;
            return (
              <g key={u.key}>
                <title>{title}</title>
                <rect x={x} y={y} width={CW} height={CH} rx="6" fill={c.fill} stroke={c.stroke} strokeWidth={p?.merged ? 2 : 1.5} strokeDasharray={p ? undefined : "4 3"} />
                {Array.from({ length: u.seats }, (_, i) => (
                  <circle key={i} cx={x + CW / 2 + (i - (u.seats - 1) / 2) * 12} cy={y + CH - 9} r="3.5" fill={c.stroke} opacity={p ? 0.9 : 0.4} />
                ))}
                <text x={x + CW / 2} y={y + 16} textAnchor="middle" fontSize="12" fontWeight="700" fill={c.text}>
                  {p ? p.team : u.kind}
                </text>
                <text x={x + CW / 2} y={y + 29} textAnchor="middle" fontSize="9.5" fill="#475569">
                  {p ? `#${p.table}` : `#${u.number}`} · {u.code}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
