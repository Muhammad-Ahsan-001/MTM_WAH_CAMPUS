/**
 * Fact store helpers: key vocabulary, normalization, authority matrix (generic roles, never names), recency.
 */
import type { RawFact } from "./reading";
import type { Fact, Message } from "./types";

export const KEYS = [
  "event.participants", "event.team_size", "event.teams", "event.staff", "event.duration_min", "event.start", "event.end", "event.budget_total",
  "venue.capacity", "venue.price", "venue.attr", "venue.unavailable", "venue.require_attr", "venue.max_rooms", "venue.max_per_room",
  "food.price", "food.fee", "food.quantity", "food.require",
  "judging.confirmed", "judging.withdrawn", "judging.fee", "judging.minutes_per_team", "judging.max_teams_per_judge", "judging.judges_per_team",
  "budget.committed", "budget.request", "budget.reserve", "budget.tax", "budget.approve",
  "schedule.block", "schedule.forbid_window",
  "people.extra", "feed.include", "total", "custom", "info",
] as const;
const KEYSET = new Set<string>(KEYS);

/** Common variants the model may emit, mapped to the vocabulary (generic wording only). */
const ALIASES: Record<string, string> = {
  "budget.total": "event.budget_total",
  "event.budget": "event.budget_total",
  "budget.limit": "event.budget_total",
  "event.headcount": "event.participants",
  "event.attendees": "event.participants",
  "event.duration": "event.duration_min",
  "schedule.start": "event.start",
  "schedule.end": "event.end",
  "venue.cost": "venue.price",
  "venue.rent": "venue.price",
  "venue.attribute": "venue.attr",
  "venue.attrs": "venue.attr",
  "food.cost": "food.price",
  "food.delivery": "food.fee",
  "food.diet": "food.require",
  "judging.judges": "judging.confirmed",
  "judging.count": "judging.confirmed",
  "judging.honorarium": "judging.fee",
  "budget.cost": "budget.committed",
  "budget.expense": "budget.committed",
  "budget.approval": "budget.approve",
  "stated.total": "total",
  "budget.stated_total": "total",
  "event.extra": "people.extra",
  "food.include": "feed.include",
};

export type FactArea = "event" | "venue" | "schedule" | "food" | "judging" | "budget";

export function keyArea(key: string, fallback: FactArea): FactArea {
  const p = key.split(".")[0];
  if (p === "event" || p === "people") return "event";
  if (p === "feed") return "food";
  if (p === "venue" || p === "food" || p === "judging" || p === "budget" || p === "schedule") return p;
  return fallback;
}

/** Normalizes one raw fact from the model: key aliases, entity-in-key, area from key, unknown keys -> custom. */
const NULLISH = /^(null|none|n\/a|na|nil|-|event|all|total|general|overall)$/i;
const ENTITY_KEYS = new Set([
  "venue.capacity", "venue.price", "venue.attr", "venue.unavailable", "food.price", "food.fee", "food.quantity", "food.require",
  "judging.confirmed", "judging.withdrawn", "budget.committed", "budget.request", "budget.approve", "schedule.block", "people.extra", "feed.include", "total",
]);

export function normalizeFact(f: RawFact): RawFact {
  let key = f.key.trim().toLowerCase().replace(/\s+/g, "");
  let entity = f.entity?.trim() || null;
  let text = f.text;
  // the model sometimes writes a DSL key inside a custom fact: "venue.require_attr(x): ..."
  if (key === "custom" && text) {
    const k = /^\s*([a-z_]+\.[a-z_]+)\s*[\[(]([^\])]*)[\])]\s*:?\s*(.*)$/i.exec(text);
    const plain = /^\s*([a-z_.]+)\s*[:=]\s*(.+)$/i.exec(text); // "budget_total: 66500" / "event.teams = 12"
    if (k && KEYSET.has(k[1].toLowerCase())) {
      key = k[1].toLowerCase();
      if (key === "venue.require_attr") text = k[2];
      else {
        entity = entity ?? (k[2] || null);
        text = k[3] || null;
      }
    } else if (plain) {
      const cand = plain[1].toLowerCase();
      const full = KEYSET.has(cand) ? cand : KEYSET.has(`event.${cand}`) ? `event.${cand}` : ALIASES[cand] ?? null;
      if (full && full !== "custom" && full !== "info") {
        key = full;
        text = typeof f.num === "number" ? null : plain[2].trim();
      }
    }
  }
  const m = /^([a-z_.]+)[\[(](.*)[\])]$/.exec(key);
  if (m) {
    key = m[1];
    if (!entity) entity = m[2].trim() || null;
  }
  key = ALIASES[key] ?? key;
  // a bare or mis-prefixed name ("budget_total", "venue.minutes_per_team") that matches exactly one key's suffix
  if (!KEYSET.has(key)) {
    const suffix = key.split(".").pop()!;
    const hits = KEYS.filter((k) => k.split(".").pop() === suffix);
    if (hits.length === 1) key = hits[0];
  }
  if (entity && NULLISH.test(entity)) entity = null;
  if (entity && !ENTITY_KEYS.has(key) && key !== "venue.require_attr" && key !== "custom") entity = null;
  let encodable = f.encodable;
  if (!KEYSET.has(key)) {
    text = `${f.key}: ${f.num ?? ""} ${f.text ?? ""}`.trim();
    key = "custom";
    encodable = false;
  }
  if (key === "custom") encodable = false;
  else encodable = true; // a known key is always encodable, whatever the flag said
  // attributes an option LACKS are not attributes
  const attrs = f.attrs.filter((a) => !/(^|_)(no|not|without|none|nahi|nahin)(_|$)/i.test(a)).map((a) => a.replace(/_(yes|available|haan)$/i, ""));
  // a judge named only in text: the name is the entity ("1 judge" per name is not a count)
  if ((key === "judging.confirmed" || key === "judging.withdrawn") && !entity && text && /[a-z]/i.test(text) && !/,|\band\b/i.test(text) && (f.num === null || f.num === 1)) {
    entity = text.trim();
    text = null;
    f = { ...f, num: null };
  }
  // a schedule block needs a label; an unlabeled one (often the event's own start/end) is info
  if (key === "schedule.block" && !entity) {
    return { ...f, key: "info", entity: null, text: `schedule.block: ${f.text ?? f.num ?? ""}`, encodable: true, area: keyArea(key, f.area) };
  }
  // numeric keys without a number carry no value: treat as info (judges need a name or a count)
  const judgeNoValue = (key === "judging.confirmed" || key === "judging.withdrawn") && !entity && typeof f.num !== "number";
  if (judgeNoValue || (NUMERIC_KEYS.has(key) && typeof f.num !== "number" && !(key === "schedule.block" && f.text))) {
    return { ...f, key: "info", entity, text: `${key}: ${f.text ?? ""}`, attrs, encodable: true, area: keyArea(key, f.area) };
  }
  return { ...f, key, entity, text, encodable, attrs, area: keyArea(key, f.area) };
}

const NUMERIC_KEYS = new Set([
  "event.participants", "event.team_size", "event.teams", "event.staff", "event.duration_min", "event.budget_total",
  "venue.capacity", "venue.price", "venue.max_rooms", "venue.max_per_room",
  "food.price", "food.fee", "food.quantity", "food.require",
  "judging.fee", "judging.minutes_per_team", "judging.max_teams_per_judge", "judging.judges_per_team",
  "budget.committed", "budget.reserve", "budget.tax", "people.extra", "total", "schedule.block",
]);

/**
 * Is this venue.unavailable fact saying the option is unavailable? The model's op is ambiguous for double negatives
 * ("forbid unavailable" has meant both), so the quoted evidence decides; the op only breaks a tie.
 */
export function saysUnavailable(f: Pick<RawFact, "op" | "evidence" | "text">): boolean {
  const s = `${f.evidence} ${f.text ?? ""}`;
  if (/\b(not|no longer|nahi|nahin|na)\s+(be\s+)?(available|free|open|khali)|unavailable|\bbooked\b|\bclosed\b|cancel|maintenance|renovat|occupied|out of service|\bband\b|not free/i.test(s)) return true;
  if (/\b(free|available|open|khali|vacant)\b/i.test(s)) return false;
  return f.op !== "remove" && f.op !== "forbid";
}

/** Ops that negate rather than assert a value. */
export const NEGATING = new Set(["remove", "forbid"]);

/** Canonical form for matching entity names across messages. */
export function canon(s: string | null | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/^(the|a|an)\s+/, "")
    .replace(/[^a-z0-9؀-ۿ]+/g, " ")
    .trim();
}

/** Namespace for entity matching: venue options share one namespace, food tiers another, etc. */
export function entityFamily(key: string): string {
  if (key.startsWith("venue.")) return "venue";
  if (key === "food.price" || key === "food.quantity") return "food.option";
  if (key.startsWith("judging.")) return "judge";
  if (key === "budget.request" || key === "budget.approve") return "request";
  return key;
}

/** Maps an entity to an already-known entity of the same family when one clearly matches (equal or contained). */
export function resolveEntity(key: string, entity: string | null, known: Map<string, string[]>): string | null {
  if (!entity) return null;
  const fam = entityFamily(key);
  const list = known.get(fam) ?? [];
  const c = canon(entity);
  const exact = list.find((k) => canon(k) === c);
  if (exact) return exact;
  const contained = list.filter((k) => {
    const ck = canon(k);
    return ck.length > 0 && c.length > 0 && (ck.split(" ").every((w) => c.split(" ").includes(w)) || c.split(" ").every((w) => ck.split(" ").includes(w)));
  });
  if (contained.length === 1) return contained[0];
  list.push(entity);
  known.set(fam, list);
  return entity;
}

// ---------- Authority matrix (generic roles only) ----------
const REQUEST_ONLY = new Set(["staff", "participant", "other_vendor", "unknown"]);

export function mayAuthor(role: string, key: string): boolean {
  if (key === "info" || key === "budget.request" || key === "total") return true;
  if (role === "top_authority") return true;
  if (REQUEST_ONLY.has(role)) return false;
  switch (role) {
    case "finance":
      return key === "budget.committed" || key === "budget.reserve" || key === "budget.tax" || key === "budget.approve";
    case "venue_provider":
      return key.startsWith("venue.") && key !== "venue.require_attr";
    case "caterer":
      return key === "food.price" || key === "food.fee" || key === "food.quantity";
    case "judging_coordinator":
      return key.startsWith("judging.");
    case "judge":
      return key === "judging.withdrawn" || key === "judging.confirmed";
    default:
      return false;
  }
}

// ---------- Recency ----------
function parseDate(d: string | null): { day: string; time: string | null } | null {
  if (!d) return null;
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/.exec(d.trim());
  if (!m) return null;
  return { day: m[1], time: m[2] ?? null };
}

/** > 0 when message a is more recent than b. Latest date wins; undated or same-day-without-time falls back to arrival order. */
export function compareRecency(a: Pick<Message, "date" | "seq">, b: Pick<Message, "date" | "seq">): number {
  const da = parseDate(a.date);
  const db = parseDate(b.date);
  if (da && db) {
    if (da.day !== db.day) return da.day < db.day ? -1 : 1;
    if (da.time && db.time && da.time !== db.time) return da.time < db.time ? -1 : 1;
  }
  return a.seq - b.seq;
}

/** Keys where several entities coexist (latest wins per entity); other keys keep one value (latest wins per key). */
export function slotOf(f: Pick<Fact, "id" | "key" | "entity" | "attrs" | "text">): string {
  const perEntity = new Set([
    "venue.capacity", "venue.price", "venue.attr", "venue.unavailable", "food.price", "food.fee", "food.quantity", "food.require",
    "judging.confirmed", "judging.withdrawn", "budget.committed", "budget.request", "budget.approve", "schedule.block",
    "people.extra", "feed.include",
  ]);
  if (f.key === "venue.require_attr") return `${f.key}|${canon(f.text ?? f.entity ?? f.attrs.join(","))}`;
  if (f.key === "schedule.forbid_window") return `${f.key}|${canon(f.text)}`;
  if (f.key === "venue.attr") return `${f.key}|${canon(f.entity)}|${canon(f.attrs.join(",") || f.text)}`;
  if (f.key === "custom" || f.key === "info" || f.key === "total") return `${f.key}|${f.id}`;
  return perEntity.has(f.key) ? `${f.key}|${canon(f.entity)}` : f.key;
}

export function fmtValue(f: Pick<Fact, "num" | "text" | "unit" | "basis">): string {
  const v = f.num ?? f.text ?? "";
  const unit = f.unit === "pkr" ? "Rs " : "";
  const num = typeof v === "number" ? v.toLocaleString("en-US") : v;
  return `${unit}${num}${f.basis && f.basis !== "fixed" ? ` ${f.basis}` : ""}`;
}
