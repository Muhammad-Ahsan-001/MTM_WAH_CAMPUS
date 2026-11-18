/**
 * The one command:  npx tsx plan.ts <file>
 * First call creates a session and plans the pack; every later call applies the new message(s) to it.
 */
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { loadEnv } from "./src/cli/load-env";
import { IngestError, ingestFile } from "./src/core/ingest";
import { newSession, runBatch } from "./src/core/pipeline";
import { mirrorToSupabase, warmUp } from "./src/core/store/supabase";
import { loadState, saveState, writeOutputs } from "./src/core/store/file";
import { COLOR, PLAIN, renderBatch, renderChecks } from "./src/core/trace";
import { fmtClock, toMin } from "./src/core/jev/solve";

async function main() {
  loadEnv();
  const p = process.stdout.isTTY && !process.env.NO_COLOR ? COLOR : PLAIN;
  const file = process.argv[2];
  if (!file) {
    console.error("usage: npx tsx plan.ts <file>");
    process.exit(2);
  }
  let raw: string;
  try {
    raw = ingestFile(file);
  } catch (e) {
    if (e instanceof IngestError) {
      console.error(p.red(`✗ ${e.message}. Nothing changed.`));
      process.exit(1);
    }
    throw e;
  }
  const state = loadState() ?? newSession(`cli ${new Date().toISOString().slice(0, 16).replace("T", " ")}`, randomUUID());
  const warm = warmUp(); // opens the Supabase connection while the model call runs
  const res = await runBatch(state, raw, basename(file));
  await Promise.race([warm, new Promise((r) => setTimeout(r, 500))]);
  saveState(state);
  writeOutputs(state);

  console.log(renderBatch(state, res.batch, p));
  console.log("");
  console.log(summary(state, p));
  const mirrored = await mirrorToSupabase(state, res.batch.batch, "cli");
  if (mirrored !== true) console.log(p.yellow(`⚠ Supabase mirror skipped: ${mirrored}`));
  console.log(p.dim("Outputs: out/plan.md · out/plan.json · out/trace.txt · out/final-plan-and-trace.md"));
}

function summary(state: import("./src/core/types").SessionState, p: typeof COLOR): string {
  const plan = state.plan;
  const box = (title: string, lines: string[]) => {
    const w = Math.max(title.length + 4, ...lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").length + 4));
    const top = `┌─ ${title} ${"─".repeat(Math.max(0, w - title.length - 4))}┐`;
    return [top, ...lines.map((l) => `│ ${l}${" ".repeat(Math.max(0, w - l.replace(/\x1b\[[0-9;]*m/g, "").length - 3))}│`), `└${"─".repeat(w - 1)}┘`].join("\n");
  };
  if (!plan) return p.red("No plan yet.");
  const e = plan.event;
  const s0 = toMin(e.start);
  const lines = [
    `Event   ${e.participants} participants · ${e.teams} teams · ${e.people_on_site} on site · ${e.people_to_feed} fed · ${e.duration_min} min`,
    `Venue   ${plan.venue ? `${plan.venue.rooms.map((r) => r.name).join(" + ")} (cap ${plan.venue.capacity}, Rs ${plan.venue.cost.toLocaleString()})` : p.red("none")}`,
    `Food    ${plan.food ? `${plan.food.tier} × ${plan.food.quantity} @ Rs ${plan.food.price_per_head} = Rs ${plan.food.cost.toLocaleString()}` : p.red("none")}`,
    `Judging ${plan.judging ? `${plan.judging.judges_used} judges, ${plan.judging.window_min} min window, Rs ${plan.judging.honoraria.toLocaleString()}` : p.red("none")}`,
    `Budget  ${plan.budget ? `Rs ${plan.budget.total.toLocaleString()} of Rs ${plan.budget.limit?.toLocaleString() ?? "?"} (remaining Rs ${plan.budget.remaining?.toLocaleString() ?? "?"})` : p.red("none")}`,
    `Schedule ${plan.schedule?.blocks.map((b) => `${fmtClock(s0, b.start)} ${b.label}`).join(" | ") ?? "none"}`,
  ];
  const rejected = state.messages.filter((m) => m.status === "rejected" || m.status === "needs_decision");
  const rej = rejected.length ? rejected.map((m) => `${p.red(m.ref)} ${m.reason}`) : ["none"];
  return [box("PLAN", lines), renderChecks(state.checks.filter((c) => c.id !== "constraint"), p), box(`REJECTED / HELD (${rejected.length})`, rej)].join("\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
