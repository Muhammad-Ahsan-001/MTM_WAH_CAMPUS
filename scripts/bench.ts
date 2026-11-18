/**
 * Token bench for the reading call. Runs sequentially (one model call at a time).
 * Usage: npx tsx scripts/bench.ts
 */
import { join } from "node:path";
import { loadEnv } from "../src/cli/load-env";
import { ingestFile } from "../src/core/ingest";
import { newSession, runBatch } from "../src/core/pipeline";
import { isValid } from "../src/core/jev/validate";
import { tokensOf } from "../src/core/trace";
import type { SessionState } from "../src/core/types";

loadEnv();

const chains: { label: string; pack: string; updates: string[] }[] = [
  { label: "sample", pack: "packs/sample/00-original.txt", updates: ["packs/sample/updates/p1-printing-change.txt", "packs/sample/updates/p2-caterer-rounding.txt"] },
  { label: "fresh", pack: "fixtures/fresh-pack.txt", updates: ["fixtures/updates/06-supplier-cap.txt"] },
];

async function one(state: SessionState, file: string) {
  const before = state.calls.length;
  const t0 = Date.now();
  const r = await runBatch(state, ingestFile(join(file)), file);
  const ms = Date.now() - t0;
  const calls = state.calls.slice(before);
  const t = tokensOf(calls);
  const u = { p: t.prompt, c: t.completion, t: t.total, r: t.reasoning };
  const p = state.plan;
  const figs = p ? `teams=${p.event.teams} fed=${p.event.people_to_feed} venue=${p.venue?.rooms.map((x) => x.name).join("+")} total=${p.budget?.total}` : "no plan";
  console.log(
    `${file} | prompt=${u.p} completion=${u.c} total=${u.t} reasoning=${u.r} | ${(ms / 1000).toFixed(1)}s | valid=${isValid(state.checks)} | ${r.newMessages.map((m) => `${m.ref}:${m.status}`).join(" ")} | ${figs}`,
  );
  if (r.problems.length) console.log(`   problems: ${r.problems.join(" | ")}`);
}

(async () => {
  for (const ch of chains) {
    const state = newSession(ch.label, `bench-${ch.label}`);
    await one(state, ch.pack);
    for (const f of ch.updates) await one(state, f);
  }
})();
