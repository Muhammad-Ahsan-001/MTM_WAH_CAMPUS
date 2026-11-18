/**
 * Area dependency graph: which plan areas Jev recomputes when facts of an area change.
 * event → all; venue → venue, budget; food → food, budget; judging → judging, food, venue, schedule, budget;
 * schedule → schedule; budget → budget.
 */
import type { Plan, PlanArea, PlanDiffEntry } from "../types";

export const DEPS: Record<string, PlanArea[]> = {
  event: ["venue", "schedule", "food", "judging", "budget"],
  venue: ["venue", "budget"],
  food: ["food", "budget"],
  judging: ["judging", "food", "venue", "schedule", "budget"],
  schedule: ["schedule"],
  budget: ["budget"],
};

export function affectedAreas(factAreas: Iterable<string>): PlanArea[] {
  const out = new Set<PlanArea>();
  for (const a of factAreas) for (const d of DEPS[a] ?? []) out.add(d);
  const order: PlanArea[] = ["venue", "schedule", "food", "judging", "budget"];
  return order.filter((a) => out.has(a));
}

/** Flattens the plan's key figures for an old → new diff. */
export function figures(plan: Plan | null): Record<string, string> {
  if (!plan) return {};
  const f: Record<string, string> = {};
  const e = plan.event;
  f["event.participants"] = String(e.participants);
  f["event.teams"] = String(e.teams);
  f["event.people_on_site"] = String(e.people_on_site);
  f["event.people_to_feed"] = String(e.people_to_feed);
  f["event.duration_min"] = String(e.duration_min);
  if (plan.venue) {
    f["venue.rooms"] = plan.venue.rooms.map((r) => r.name).join(" + ");
    f["venue.capacity"] = String(plan.venue.capacity);
    f["venue.cost"] = String(plan.venue.cost);
  }
  if (plan.food) {
    f["food.tier"] = plan.food.tier;
    f["food.price_per_head"] = String(plan.food.price_per_head);
    f["food.quantity"] = String(plan.food.quantity);
    f["food.cost"] = String(plan.food.cost);
  }
  if (plan.judging) {
    f["judging.judges_used"] = String(plan.judging.judges_used);
    f["judging.window_min"] = String(plan.judging.window_min);
    f["judging.honoraria"] = String(plan.judging.honoraria);
  }
  if (plan.schedule) f["schedule.blocks"] = plan.schedule.blocks.map((b) => `${b.label} ${b.minutes}`).join(", ");
  if (plan.budget) {
    f["budget.total"] = String(plan.budget.total);
    f["budget.remaining"] = String(plan.budget.remaining ?? "");
    f["budget.tax"] = String(plan.budget.tax);
    f["budget.reserve"] = String(plan.budget.reserve);
  }
  return f;
}

export function diffPlans(a: Plan | null, b: Plan | null): PlanDiffEntry[] {
  const fa = figures(a);
  const fb = figures(b);
  const keys = [...new Set([...Object.keys(fa), ...Object.keys(fb)])];
  return keys.filter((k) => fa[k] !== fb[k]).map((k) => ({ path: k, old: fa[k] ?? "—", new: fb[k] ?? "—" }));
}
