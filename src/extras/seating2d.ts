// 2D seating allocator for the Event Kit. Pure code, zero tokens, unit-testable.
// Each unit (trio table / duo desk / solo desk) occupies one grid cell with a seat count.
// Merges are only made between grid neighbours (4-neighbourhood) inside the same room.

export type UnitKind = "trio" | "duo" | "solo";
export type Front = "north" | "south" | "east" | "west";

export const SEATS: Record<UnitKind, number> = { trio: 3, duo: 2, solo: 1 };

export interface Team {
  id: string;
  name: string;
  size: number;
  members: string[];
}

export interface RoomSpec {
  name: string;
  capacity: number;
  front: Front;
  rows: number;
  cols: number;
  trio: number;
  duo: number;
  solo: number;
}

export interface LayoutIssue {
  line: number;
  message: string;
  error: boolean;
}

export interface Unit {
  key: string; // `${roomIndex}:${row}:${col}`
  code: string; // R3C4 (1-based)
  room: string;
  roomIndex: number;
  row: number; // 0-based
  col: number; // 0-based
  kind: UnitKind;
  seats: number;
  number: number; // global table number, 1-based
}

export interface Placement {
  team: string;
  units: string[]; // unit keys
  table: number;
  room: string;
  unit: string; // "R3C4" or "R3C4+R3C5"
  seats: number;
  empty: number;
  merged: boolean;
}

export interface Allocation {
  units: Unit[];
  placements: Placement[];
  merges: string[];
  notes: string[];
  unseated: Team[];
  seatsTotal: number;
  seatsUsed: number;
  emptySeats: number;
  people: number;
  shortfall: number; // people who could not be seated
  seatGap: number; // max(0, people - seatsTotal)
}

export interface SeatingExport {
  teams: { id: string; name: string; size: number; members: string[] }[];
  tables: { team: string; table: number; room: string; unit: string }[];
}

// ---------------------------------------------------------------- teams

export interface TeamCounts {
  trio: number;
  duo: number;
  solo: number;
}

/** Split participants into teams of (at most) teamSize; remainder becomes smaller teams. */
export function countsFromPlan(participants: number, teams: number, teamSize: number | null): TeamCounts {
  const p = Math.max(0, Math.floor(participants || 0));
  if (p === 0) return { trio: 0, duo: 0, solo: 0 };
  let s = teamSize && teamSize > 0 ? Math.floor(teamSize) : 0;
  let n = teams && teams > 0 ? Math.floor(teams) : 0;
  if (!s) s = n ? Math.ceil(p / n) : 3;
  s = Math.min(3, Math.max(1, s));
  if (!n) n = Math.ceil(p / s);
  const sizes: number[] = [];
  if (n * s >= p) {
    for (let i = 0; i < n; i++) sizes.push(s);
    let deficit = n * s - p;
    // shrink teams from the end, one seat per pass, never below 1
    while (deficit > 0) {
      let changed = false;
      for (let i = sizes.length - 1; i >= 0 && deficit > 0; i--) {
        if (sizes[i] > 1) {
          sizes[i]--;
          deficit--;
          changed = true;
        }
      }
      if (!changed) break;
    }
  } else {
    for (let i = 0; i < n; i++) sizes.push(s);
    let extra = p - n * s;
    while (extra > 0) {
      const t = Math.min(s, extra);
      sizes.push(t);
      extra -= t;
    }
  }
  const c: TeamCounts = { trio: 0, duo: 0, solo: 0 };
  for (const z of sizes) {
    if (z >= 3) c.trio++;
    else if (z === 2) c.duo++;
    else c.solo++;
  }
  return c;
}

export function teamId(i: number): string {
  return `T${String(i + 1).padStart(2, "0")}`;
}

export function teamsFromCounts(c: TeamCounts): Team[] {
  const out: Team[] = [];
  const push = (size: number, k: number) => {
    for (let i = 0; i < k; i++) {
      const id = teamId(out.length);
      out.push({ id, name: `Team ${id.slice(1)}`, size, members: [] });
    }
  };
  push(3, Math.max(0, Math.floor(c.trio || 0)));
  push(2, Math.max(0, Math.floor(c.duo || 0)));
  push(1, Math.max(0, Math.floor(c.solo || 0)));
  return out;
}

/** Parse `Team name | member1, member2, …` per line (also accepts `Team name | 3`). */
export function parseRoster(text: string): { teams: Team[]; errors: LayoutIssue[] } {
  const teams: Team[] = [];
  const errors: LayoutIssue[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    let name = line;
    let rest = "";
    const bar = line.indexOf("|");
    if (bar >= 0) {
      name = line.slice(0, bar).trim();
      rest = line.slice(bar + 1).trim();
    } else {
      const colon = line.indexOf(":");
      if (colon >= 0) {
        name = line.slice(0, colon).trim();
        rest = line.slice(colon + 1).trim();
      }
    }
    if (!name) {
      errors.push({ line: i + 1, message: `Line ${i + 1}: missing team name before "|"`, error: true });
      return;
    }
    let members: string[] = [];
    let size = 0;
    if (/^\d+$/.test(rest)) {
      size = parseInt(rest, 10);
    } else {
      members = rest
        .split(/[,;]/)
        .map((m) => m.trim())
        .filter(Boolean);
      size = members.length;
    }
    if (size <= 0) {
      errors.push({ line: i + 1, message: `Line ${i + 1}: "${name}" has no members — counted as 1 person`, error: false });
      size = 1;
    }
    const id = teamId(teams.length);
    teams.push({ id, name, size, members });
  });
  return { teams, errors };
}

// ---------------------------------------------------------------- layout

const FRONTS: Front[] = ["north", "south", "east", "west"];
const FRONT_ALIAS: Record<string, Front> = { n: "north", s: "south", e: "east", w: "west", top: "north", bottom: "south", right: "east", left: "west" };

function num(v: string): number | null {
  const m = v.match(/-?\d+/);
  return m ? parseInt(m[0], 10) : null;
}

export function parseLayout(text: string): { rooms: RoomSpec[]; issues: LayoutIssue[] } {
  const rooms: RoomSpec[] = [];
  const issues: LayoutIssue[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, i) => {
    const ln = i + 1;
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) return;
    const spec: Partial<RoomSpec> & { gridSet?: boolean } = {};
    let anyUnit = false;
    for (const seg of line.split("|")) {
      const s = seg.trim();
      if (!s) continue;
      const m = s.match(/^([a-z ]+?)\s*[:=]\s*(.*)$/i);
      if (!m) {
        if (!spec.name) spec.name = s;
        else issues.push({ line: ln, message: `Line ${ln}: could not read "${s}" (expected key: value)`, error: false });
        continue;
      }
      const key = m[1].trim().toLowerCase();
      const val = m[2].trim();
      if (key === "room" || key === "name") spec.name = val;
      else if (key.startsWith("cap")) {
        const n = num(val);
        if (n === null || n < 0) issues.push({ line: ln, message: `Line ${ln}: capacity "${val}" is not a number`, error: true });
        else spec.capacity = n;
      } else if (key === "front" || key === "stage") {
        const f = val.toLowerCase();
        const fr = (FRONTS as string[]).includes(f) ? (f as Front) : FRONT_ALIAS[f];
        if (!fr) issues.push({ line: ln, message: `Line ${ln}: front "${val}" unknown — using north`, error: false });
        spec.front = fr ?? "north";
      } else if (key === "grid") {
        const g = val.toLowerCase().match(/(\d+)\s*[x×*,]\s*(\d+)/);
        if (!g) issues.push({ line: ln, message: `Line ${ln}: grid "${val}" should look like 10x6 (rows x cols)`, error: false });
        else {
          spec.rows = parseInt(g[1], 10);
          spec.cols = parseInt(g[2], 10);
          spec.gridSet = true;
        }
      } else if (key.startsWith("trio") || key.startsWith("duo") || key.startsWith("solo")) {
        const k: UnitKind = key.startsWith("trio") ? "trio" : key.startsWith("duo") ? "duo" : "solo";
        const n = num(val);
        if (n === null || n < 0) issues.push({ line: ln, message: `Line ${ln}: ${k} count "${val}" is not a number`, error: true });
        else {
          spec[k] = n;
          anyUnit = true;
        }
      } else {
        issues.push({ line: ln, message: `Line ${ln}: unknown key "${m[1].trim()}" ignored`, error: false });
      }
    }
    if (!spec.name) {
      issues.push({ line: ln, message: `Line ${ln}: missing "Room: <name>"`, error: true });
      return;
    }
    const capacity = spec.capacity ?? 0;
    let trio = spec.trio ?? 0;
    const duo = spec.duo ?? 0;
    const solo = spec.solo ?? 0;
    if (!anyUnit) {
      if (!capacity) {
        issues.push({ line: ln, message: `Line ${ln}: "${spec.name}" has no capacity and no trio/duo/solo counts`, error: true });
        return;
      }
      trio = Math.ceil(capacity / 3);
    }
    const total = trio + duo + solo;
    if (total === 0) {
      issues.push({ line: ln, message: `Line ${ln}: "${spec.name}" has 0 tables`, error: true });
      return;
    }
    let cols = spec.cols && spec.cols > 0 ? spec.cols : Math.min(6, total);
    let rows = spec.rows && spec.rows > 0 ? spec.rows : Math.ceil(total / cols);
    if (rows * cols < total) {
      const need = Math.ceil(total / cols);
      issues.push({
        line: ln,
        message: `Line ${ln}: grid ${rows}x${cols} holds ${rows * cols} units but ${total} are listed — extended to ${need}x${cols}`,
        error: false,
      });
      rows = need;
    }
    if (cols < 1) cols = 1;
    const seats = trio * 3 + duo * 2 + solo;
    if (capacity && seats > capacity) {
      issues.push({ line: ln, message: `Line ${ln}: ${seats} seats exceed stated capacity ${capacity}`, error: false });
    }
    rooms.push({ name: spec.name, capacity: capacity || seats, front: spec.front ?? "north", rows, cols, trio, duo, solo });
  });
  return { rooms, issues };
}

export function formatRoom(r: RoomSpec): string {
  return `Room: ${r.name} | capacity: ${r.capacity} | front: ${r.front} | grid: ${r.rows}x${r.cols} | trio: ${r.trio} | duo: ${r.duo} | solo: ${r.solo}`;
}

/** Default layout: trio tables = ceil(capacity/3) on a ~6-column grid. */
export function defaultRoom(name: string, capacity: number): RoomSpec {
  const trio = Math.max(1, Math.ceil(capacity / 3));
  const cols = Math.min(6, trio);
  return { name, capacity, front: "north", rows: Math.ceil(trio / cols), cols, trio, duo: 0, solo: 0 };
}

/** Mixed example from the same capacity: ~half seats on trios, ~20% on duos, rest solos. */
export function mixedRoom(name: string, capacity: number): RoomSpec {
  const cap = Math.max(1, capacity);
  const trio = Math.floor((cap * 0.5) / 3);
  const duo = Math.floor((cap * 0.2) / 2);
  const solo = Math.max(0, cap - trio * 3 - duo * 2);
  const total = trio + duo + solo;
  const cols = Math.min(8, Math.max(1, total));
  return { name, capacity: cap, front: "north", rows: Math.ceil(total / cols), cols, trio, duo, solo };
}

// ---------------------------------------------------------------- allocation

export function buildUnits(rooms: RoomSpec[]): Unit[] {
  const units: Unit[] = [];
  let n = 0;
  rooms.forEach((r, ri) => {
    const kinds: UnitKind[] = [];
    for (let i = 0; i < r.trio; i++) kinds.push("trio");
    for (let i = 0; i < r.duo; i++) kinds.push("duo");
    for (let i = 0; i < r.solo; i++) kinds.push("solo");
    kinds.forEach((kind, i) => {
      const row = Math.floor(i / r.cols);
      const col = i % r.cols;
      n++;
      units.push({ key: `${ri}:${row}:${col}`, code: `R${row + 1}C${col + 1}`, room: r.name, roomIndex: ri, row, col, kind, seats: SEATS[kind], number: n });
    });
  });
  return units;
}

export function allocate(rooms: RoomSpec[], teams: Team[]): Allocation {
  const units = buildUnits(rooms);
  const byKey = new Map(units.map((u) => [u.key, u]));
  const free = new Set(units.map((u) => u.key));
  const multiRoom = rooms.length > 1;
  const where = (u: Unit) => (multiRoom ? `${u.room} ${u.code}` : u.code);
  const placements: Placement[] = [];
  const merges: string[] = [];
  const notes: string[] = [];
  const seated = new Set<string>();

  const neighbours = (u: Unit): Unit[] => {
    const out: Unit[] = [];
    for (const [dr, dc] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      const k = `${u.roomIndex}:${u.row + dr}:${u.col + dc}`;
      const v = byKey.get(k);
      if (v && free.has(k)) out.push(v);
    }
    return out;
  };
  const freeOf = (kind: UnitKind) => units.filter((u) => u.kind === kind && free.has(u.key));

  const place = (t: Team, us: Unit[]) => {
    for (const u of us) free.delete(u.key);
    const seats = us.reduce((a, u) => a + u.seats, 0);
    const first = us.reduce((a, u) => (u.number < a.number ? u : a), us[0]);
    placements.push({
      team: t.id,
      units: us.map((u) => u.key),
      table: first.number,
      room: first.room,
      unit: us.map((u) => u.code).join("+"),
      seats,
      empty: Math.max(0, seats - t.size),
      merged: us.length > 1,
    });
    seated.add(t.id);
  };

  const label = (s: number) => (s >= 3 ? "trio" : s === 2 ? "duo" : "solo");
  const waiting = (size: number | ((s: number) => boolean)) =>
    teams.filter((t) => !seated.has(t.id) && (typeof size === "number" ? Math.min(3, t.size) === size && t.size <= 3 : size(t.size)));

  // 1. Exact matches: trio→trio table, duo→duo desk, solo→solo desk.
  for (const [size, kind] of [[3, "trio"], [2, "duo"], [1, "solo"]] as [number, UnitKind][]) {
    for (const t of waiting(size)) {
      const u = freeOf(kind)[0];
      if (!u) break;
      place(t, [u]);
    }
  }

  // 2. Trio overflow: duo + adjacent solo, else 3 adjacent solos.
  for (const t of waiting(3)) {
    let done = false;
    for (const d of freeOf("duo")) {
      const s = neighbours(d).find((n) => n.kind === "solo");
      if (s) {
        place(t, [d, s]);
        merges.push(`Merged duo desk ${where(d)} + solo desk ${where(s)} → trio for ${t.id}`);
        done = true;
        break;
      }
    }
    if (done) continue;
    outer: for (const a of freeOf("solo")) {
      for (const b of neighbours(a).filter((n) => n.kind === "solo")) {
        const cands = [...neighbours(b), ...neighbours(a)].filter((n) => n.kind === "solo" && n.key !== a.key && n.key !== b.key);
        if (cands.length) {
          const trio = [a, b, cands[0]].sort((x, y) => x.number - y.number);
          place(t, trio);
          merges.push(`Merged solo desks ${trio.map(where).join("+")} → trio for ${t.id}`);
          done = true;
          break outer;
        }
      }
    }
  }

  // 3. Duo overflow: 2 adjacent solos, else a trio table with one empty seat.
  for (const t of waiting(2)) {
    let done = false;
    for (const a of freeOf("solo")) {
      const b = neighbours(a).find((n) => n.kind === "solo");
      if (b) {
        const pair = [a, b].sort((x, y) => x.number - y.number);
        place(t, pair);
        merges.push(`Merged solo desks ${pair.map(where).join("+")} → duo for ${t.id}`);
        done = true;
        break;
      }
    }
    if (done) continue;
    const tr = freeOf("trio")[0];
    if (tr) {
      place(t, [tr]);
      notes.push(`Duo ${t.id} seated at trio table ${where(tr)} (1 empty seat)`);
    }
  }

  // 4. Solo overflow: any leftover seat (smallest unit first).
  for (const t of waiting(1)) {
    const u = [...freeOf("duo"), ...freeOf("trio")][0];
    if (!u) break;
    place(t, [u]);
    notes.push(`Solo ${t.id} seated at ${u.kind} ${u.kind === "trio" ? "table" : "desk"} ${where(u)} (${u.seats - 1} empty seat${u.seats - 1 === 1 ? "" : "s"})`);
  }

  // 5. Anyone still waiting (incl. teams larger than 3): grow a cluster of adjacent free units.
  for (const t of teams.filter((x) => !seated.has(x.id) && x.size > 0)) {
    let best: Unit[] | null = null;
    let bestWaste = Infinity;
    for (const start of units) {
      if (!free.has(start.key)) continue;
      const cluster: Unit[] = [start];
      const inC = new Set([start.key]);
      let seats = start.seats;
      let frontier = [start];
      while (seats < t.size && frontier.length) {
        const next: Unit[] = [];
        for (const f of frontier) {
          for (const n of neighbours(f)) {
            if (inC.has(n.key) || seats >= t.size) continue;
            inC.add(n.key);
            cluster.push(n);
            next.push(n);
            seats += n.seats;
          }
        }
        frontier = next;
      }
      if (seats >= t.size) {
        const waste = seats - t.size;
        if (waste < bestWaste || (waste === bestWaste && best && cluster.length < best.length)) {
          best = cluster;
          bestWaste = waste;
        }
        if (waste === 0 && cluster.length === 1) break;
      }
    }
    if (best) {
      best.sort((x, y) => x.number - y.number);
      place(t, best);
      if (best.length > 1) {
        const kinds = [...new Set(best.map((u) => u.kind))].join("/");
        merges.push(`Merged ${kinds} units ${best.map(where).join("+")} → ${t.size}-seat table for ${t.id}${bestWaste ? ` (${bestWaste} empty)` : ""}`);
      } else {
        notes.push(`${label(t.size)} ${t.id} seated at ${best[0].kind} ${where(best[0])}${bestWaste ? ` (${bestWaste} empty)` : ""}`);
      }
    }
  }

  const solosMerged = merges.filter((m) => m.includes("solo desk")).length;
  if (solosMerged) notes.unshift(`${solosMerged} merge${solosMerged === 1 ? "" : "s"} used empty solo desks because non-solo teams were waiting.`);

  const unseated = teams.filter((t) => !seated.has(t.id) && t.size > 0);
  const seatsTotal = units.reduce((a, u) => a + u.seats, 0);
  const people = teams.reduce((a, t) => a + Math.max(0, t.size), 0);
  const seatsUsed = people - unseated.reduce((a, t) => a + t.size, 0);
  const shortfall = unseated.reduce((a, t) => a + t.size, 0);
  if (unseated.length && seatsTotal - seatsUsed >= shortfall) {
    notes.push(`${seatsTotal - seatsUsed} seats remain free but none form a big-enough adjacent group — add tables or adjust the grid.`);
  }
  return {
    units,
    placements,
    merges,
    notes,
    unseated,
    seatsTotal,
    seatsUsed,
    emptySeats: seatsTotal - seatsUsed,
    people,
    shortfall,
    seatGap: Math.max(0, people - seatsTotal),
  };
}

export function toExport(teams: Team[], a: Allocation): SeatingExport {
  return {
    teams: teams.map((t) => ({ id: t.id, name: t.name, size: t.size, members: t.members })),
    tables: a.placements.map((p) => ({ team: p.team, table: p.table, room: p.room, unit: p.unit })),
  };
}
