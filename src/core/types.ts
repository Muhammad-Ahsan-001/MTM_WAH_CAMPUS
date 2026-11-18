import type { CallRecord } from "./llm";
import type { RawFact, RawMessage } from "./reading";

export type MessageStatus =
  | "applied"
  | "superseded"
  | "irrelevant"
  | "request"
  | "rejected"
  | "duplicate"
  | "needs_decision";

export type FactStatus = "active" | "superseded" | "rejected" | "pending";

export type PlanArea = "venue" | "schedule" | "food" | "judging" | "budget";
export const PLAN_AREAS: PlanArea[] = ["venue", "schedule", "food", "judging", "budget"];

export interface Fact extends RawFact {
  id: string; // `${ref}.${i}`
  ref: string; // message ref, e.g. m3
  order: number; // arrival order (global message seq)
  status: FactStatus;
  reason?: string;
}

export interface Message extends Omit<RawMessage, "facts"> {
  seq: number; // global arrival order across the session
  batch: number;
  status: MessageStatus;
  reason: string;
  facts: Fact[];
}

export interface Decision {
  batch: number;
  kind: MessageStatus | "info" | "fallback" | "cap";
  ref?: string;
  area?: string;
  reason: string;
}

export interface LineItem {
  label: string;
  amount: number;
  refs: string[];
  detail?: string;
}

export interface ScheduleBlock {
  label: string;
  kind: "opening" | "build" | "lunch" | "judging" | "closing" | "required";
  start: number; // minutes from event start
  minutes: number;
  fixed?: string | null;
  refs: string[];
  /** Id of the fact that required this block, if any. */
  src?: string;
}

export interface Plan {
  event: {
    participants: number;
    team_size: number | null;
    teams: number;
    staff: number;
    extras: { group: string; count: number; refs: string[] }[];
    people_on_site: number;
    people_to_feed: number;
    duration_min: number;
    start: string | null;
    end: string | null;
    budget_total: number | null;
    refs: Record<string, string[]>;
  };
  venue: {
    rooms: { name: string; capacity: number; cost: number; attrs: string[]; refs: string[] }[];
    capacity: number;
    cost: number;
    headroom: number;
    required_attrs: string[];
    reason: string;
  } | null;
  food: {
    tier: string;
    price_per_head: number;
    quantity: number;
    fees: LineItem[];
    diets: { diet: string; count: number; refs: string[] }[];
    cost: number;
    reason: string;
    refs: string[];
  } | null;
  judging: {
    confirmed: number;
    withdrawn: string[];
    available: number;
    judges_needed: number;
    judges_used: number;
    judges_per_team: number;
    max_teams_per_judge: number;
    minutes_per_team: number;
    window_min: number;
    fee: number;
    honoraria: number;
    assignments: { team: string; judges: string[] }[];
    judge_names: string[];
    refs: string[];
  } | null;
  schedule: {
    blocks: ScheduleBlock[];
    total_min: number;
    relative: boolean;
  } | null;
  budget: {
    items: LineItem[];
    subtotal: number;
    tax: number;
    reserve: number;
    total: number;
    limit: number | null;
    remaining: number | null;
  } | null;
  requests: { ref: string; label: string; amount: number | null; affordable: boolean | null; approved: boolean }[];
  unencoded: { ref: string; area: string; text: string; handled: boolean; note: string }[];
}

export interface Check {
  id: "figures" | "budget" | "venue" | "schedule" | "judges" | "areas" | "constraint";
  label: string;
  pass: boolean;
  detail: string;
  /** Advisory lines (constraints outside the DSL) are shown but never make the plan invalid. */
  advisory?: boolean;
}

export interface PlanDiffEntry {
  path: string;
  old: string;
  new: string;
}

export interface BatchInfo {
  batch: number;
  file: string;
  at: string;
  message_refs: string[];
  calls: number[]; // call seqs
  areas_called: string[];
  areas_recomputed: string[];
  diff: PlanDiffEntry[];
  plan_valid: boolean;
  duration_ms: number;
  error?: string;
}

export interface SessionState {
  version: 1;
  id: string;
  label: string;
  created_at: string;
  next_call_seq: number;
  next_msg_seq: number;
  messages: Message[];
  calls: CallRecord[];
  decisions: Decision[];
  batches: BatchInfo[];
  plan: Plan | null;
  checks: Check[];
  plan_version: number;
}
