/**
 * P0 smoke test. Usage: npx tsx scripts/openai-smoke.ts [modelA modelB ...]
 * Default candidates: OPENAI_SMOKE_MODELS (comma list) or OPENAI_MODEL.
 * For each model: a reading call on fixtures/sample-pack.txt (if present), printing response.model,
 * the full usage object as returned, latency, and generic quality signals (no pack values asserted).
 * Results are written to out/smoke/ (gitignored) for review.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { loadEnv, requireEnv } from "../src/core/env";
import { CallLedger, callModel } from "../src/core/llm";
import { READING_SCHEMA, ReadingSchema, SYSTEM_PROMPT, buildReadingUser } from "../src/core/reading";

loadEnv();
const PACK = "fixtures/sample-pack.txt";

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

async function listModels(): Promise<string[]> {
  const res = await fetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${requireEnv("OPENAI_API_KEY")}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`models list http ${res.status}: ${await res.text()}`);
  const json: any = await res.json();
  return (json.data as { id: string }[]).map((m) => m.id).sort();
}

async function main() {
  const args = process.argv.slice(2);
  const candidates = args.length
    ? args
    : (process.env.OPENAI_SMOKE_MODELS?.split(",").map((s) => s.trim()).filter(Boolean) ?? [requireEnv("OPENAI_MODEL")]);

  const available = await listModels();
  const small = available.filter((id) => /^(gpt|o\d)/.test(id) && /(mini|nano|small)/.test(id) && !/(audio|realtime|tts|transcribe|search|image)/.test(id));
  console.log(`Models on this key: ${available.length}. Small chat candidates:\n  ${small.join("\n  ")}\n`);

  const raw = existsSync(PACK) ? readFileSync(PACK, "utf8").replace(/^﻿/, "") : null;
  const input = raw ?? "Room Q seats 12 at Rs 7 per hour. (invented smoke-test sentence)";
  if (!raw) console.log(`(${PACK} not found: using an invented one-line input)\n`);
  mkdirSync("out/smoke", { recursive: true });

  for (const model of candidates) {
    const ledger = new CallLedger(0, 1, 2);
    console.log(`=== ${model} ===`);
    try {
      const { data, record } = await callModel(ledger, {
        area: "reading",
        system: SYSTEM_PROMPT,
        user: buildReadingUser(input, 1),
        schemaName: "reading",
        schema: READING_SCHEMA as unknown as Record<string, unknown>,
        parse: (v) => ReadingSchema.parse(v),
        model,
      });
      const facts = data.messages.flatMap((m) => m.facts.map((f) => ({ m, f })));
      const badEvidence = facts.filter(({ f }) => !norm(input).includes(norm(f.evidence)));
      const longEvidence = facts.filter(({ f }) => f.evidence.trim().split(/\s+/).length > 8);
      console.log(`response.model : ${record.model}`);
      console.log(`usage (raw)    : ${JSON.stringify(record.usage_raw)}`);
      console.log(`latency        : ${(record.latency_ms / 1000).toFixed(2)} s   calls: ${ledger.used}`);
      console.log(`messages=${data.messages.length} facts=${facts.length} injection=${data.messages.filter((m) => m.injection).map((m) => m.ref).join(",") || "-"} irrelevant=${data.messages.filter((m) => m.relevance === "irrelevant").map((m) => m.ref).join(",") || "-"}`);
      console.log(`evidence not verbatim: ${badEvidence.length}   evidence > 8 words: ${longEvidence.length}`);
      for (const m of data.messages) {
        console.log(`  ${m.ref} [${m.role}/${m.kind}${m.injection ? "/INJECTION" : ""}${m.relevance === "irrelevant" ? "/irrelevant" : ""}] ${m.date ?? "-"} ${m.sender ?? "?"}: ${m.summary}`);
        for (const f of m.facts) {
          const val = f.num ?? f.text ?? "";
          const flag = norm(input).includes(norm(f.evidence)) ? "" : "  <-- evidence not verbatim";
          console.log(`      ${f.op} ${f.key}${f.entity ? `[${f.entity}]` : ""} = ${val}${f.unit ? ` ${f.unit}` : ""}${f.basis ? ` ${f.basis}` : ""}${f.attrs.length ? ` {${f.attrs.join(",")}}` : ""}${f.encodable ? "" : " (encodable:false)"}  "${f.evidence}"${flag}`);
        }
      }
      writeFileSync(`out/smoke/${model.replace(/[^\w.-]/g, "_")}.json`, JSON.stringify({ record, data }, null, 2));
    } catch (e) {
      console.log(`FAILED: ${(e as Error).message}`);
      for (const c of ledger.calls) console.log(`  call #${c.seq} model=${c.model} error=${c.error} usage=${JSON.stringify(c.usage_raw)}`);
    }
    console.log("");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
