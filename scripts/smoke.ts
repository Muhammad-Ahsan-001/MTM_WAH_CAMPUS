/**
 * Smoke test over fixtures/scenarios.json: reset → pack → each update, in-process (state kept in memory; only
 * writes debug copies to out/smoke/, which is gitignored).
 * Assertions are STRUCTURAL ONLY: plan valid after each batch, expected message status, calls per update ≤ cap,
 * time caps. Never asserts pack values.
 * Usage: npx tsx scripts/smoke.ts [chainIndex|all]   (default: 0 = main chain, plus formats and edge cases)
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnv } from "../src/cli/load-env";
import { IngestError, ingestFile } from "../src/core/ingest";
import { newSession, runBatch } from "../src/core/pipeline";
import { POLICY } from "../src/core/policy";
import { isValid } from "../src/core/jev/validate";
import { tokensOf } from "../src/core/trace";
import type { SessionState } from "../src/core/types";

loadEnv();
const F = "fixtures";
const scen = JSON.parse(readFileSync(join(F, "scenarios.json"), "utf8"));
const which = process.argv[2] ?? "0";
let failures = 0;
const fail = (s: string) => {
  failures++;
  console.log(`   ✗ ${s}`);
};

async function runChain(pack: string, updates: { file: string; expect: string }[], label: string) {
  const state: SessionState = newSession(label, `smoke-${label}`);
  const lines: string[] = [];
  const t0 = Date.now();
  const r = await runBatch(state, ingestFile(join(F, pack)), pack);
  const ok = isValid(state.checks);
  lines.push(`${ok ? "✓" : "✗"} ${label} pack ${pack}: ${r.newMessages.length} msgs, ${r.batch.calls.length} calls, ${(r.batch.duration_ms / 1000).toFixed(1)} s, statuses ${r.newMessages.map((m) => `${m.ref}:${m.status}`).join(" ")}`);
  if (!ok) lines.push(`   ✗ plan invalid: ${state.checks.filter((c) => !c.pass && !c.advisory).map((c) => `${c.label}: ${c.detail}`).join(" | ")}`);
  if (!ok) failures++;
  if (r.batch.calls.length > POLICY.caps.fullRunCalls) fail(`full run used ${r.batch.calls.length} calls > cap`);
  if (r.batch.duration_ms > 120_000) fail("full run over 2 min");
  for (const u of updates) {
    const res = await runBatch(state, ingestFile(join(F, u.file)), u.file);
    const statuses = res.newMessages.map((m) => m.status);
    const got = statuses.includes(u.expect as never);
    const valid = isValid(state.checks);
    const callsOk = res.batch.calls.length <= POLICY.caps.updateCalls;
    const mark = got && valid && callsOk ? "✓" : "✗";
    lines.push(
      `${mark} ${u.file.padEnd(36)} expect=${u.expect.padEnd(14)} got=${statuses.join(",").padEnd(14)} valid=${valid ? "yes" : "NO"} calls=${res.batch.calls.length} areas=[${res.batch.areas_called.join(",")}] recomputed=[${res.batch.areas_recomputed.join(",")}] ${(res.batch.duration_ms / 1000).toFixed(1)}s`,
    );
    for (const m of res.newMessages) if (m.status !== "applied") lines.push(`      ${m.ref} ${m.status}: ${m.reason}`);
    if (!valid) lines.push(`      plan invalid: ${state.checks.filter((c) => !c.pass && !c.advisory).map((c) => `${c.label}: ${c.detail}`).join(" | ")}`);
    if (mark === "✗") failures++;
    if (res.batch.duration_ms > 60_000) fail(`${u.file}: update over 1 min`);
  }
  mkdirSync("out/smoke", { recursive: true });
  writeFileSync(`out/smoke/${label}.state.json`, JSON.stringify(state, null, 1));
  const t = tokensOf(state.calls);
  lines.push(`  ${label}: ${state.calls.length} calls, tokens prompt=${t.prompt} completion=${t.completion} total=${t.total} reasoning=${t.reasoning}, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  return lines;
}

async function main() {
  const jobs: Promise<string[]>[] = [];
  const packs = scen.packs as { pack: string; updates: { file: string; expect: string }[] }[];
  const chains = which === "all" ? packs.map((_, i) => i) : which === "formats" ? [] : which.split(",").map(Number);
  for (const i of chains) jobs.push(runChain(packs[i].pack, packs[i].updates ?? [], `chain${i}`));
  if (which === "0" || which === "all" || which === "formats")
    packs.forEach((p, i) => {
      if (i > 1 && !(p.updates ?? []).length) jobs.push(runChain(p.pack, [], `format${i}`));
    });
  const edge = (async () => {
    const out: string[] = [];
    for (const e of (scen.edge ?? []) as { file: string; expect: string }[]) {
      try {
        ingestFile(join(F, e.file));
        out.push(`${e.expect === "error" ? "✗" : "✓"} edge ${e.file}: readable (expect ${e.expect})`);
        if (e.expect === "error") failures++;
      } catch (err) {
        const ok = err instanceof IngestError && e.expect === "error";
        out.push(`${ok ? "✓" : "✗"} edge ${e.file}: ${(err as Error).message}`);
        if (!ok) failures++;
      }
    }
    return out;
  })();
  const results = await Promise.all([...jobs, edge]);
  for (const r of results) console.log(r.join("\n"));
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL GREEN");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
