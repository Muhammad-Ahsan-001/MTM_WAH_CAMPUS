# SceneBnao architecture — "the model reads, Jev decides"

One command: `npx tsx plan.ts <file>`. The first call creates a session and plans the whole pack; every later call
applies the new message(s) to the same session. `npx tsx reset.ts` starts over. Web: `POST /api/ingest` runs the
same pipeline with Supabase as the state store.

The model turns language into typed facts. It never produces the plan, totals, choices or verdicts. **Jev** is our
deterministic, zero-token engine: reconcile → solve → validate. That split is also the main prompt-injection defence:
the worst a message can do is produce a fact, and every fact goes through code checks.

## Pipeline (one batch = one input file)

```
file ──► ingest (code) ──► reading call (1 model call, area=reading) ──► typed messages + facts
                                                                             │
     ┌───────────────────── Jev, 0 tokens ──────────────────────────────────┘
     ▼
 for each message, in arrival order:
   reconcile (injection / relevance / duplicate / authority / recency / requests / self-consistency)
   → tentative apply → solve → validate
   → supplier below need? reject + roll back
   → plan was valid and now is not? roll back, mark "needs human decision" with the shortfall
 final solve + validate (first batch: roll back the culprit if the plan is invalid)
 facts marked encodable:false → area fallback (≤ 1 call per area per batch, Jev re-validates)
 render (templates) → out/*.md|json|txt, .scenebnao/state.json, Supabase mirror (3 s, non-blocking)
```

## Why each part exists (and what breaks without it)

| Part | File | Purpose | What breaks without it |
|---|---|---|---|
| Ingest | `src/core/ingest.ts` | Raw text exactly as given (UTF-8, only a BOM stripped; UTF-16 exports decoded), any layout/extension; empty/garbage → clear error | Tampered input = DQ; odd formats crash; garbage burns a model call |
| Reading call | `src/core/reading.ts` | Language → typed facts: Roman Urdu, slang, "1.2k", "dedh lakh", number words; segments messages itself | Can't read varied wording or layouts |
| Strict schema + Zod | `reading.ts`, `llm.ts` | OpenAI structured outputs (`json_schema`, strict) + Zod validation; one traced retry on parse/network errors | Bad JSON corrupts state |
| Fact normalization | `src/core/facts.ts` | Aliases → our key vocabulary, entity resolution against known names, `"null"`/`"event"` entities dropped, attributes an option *lacks* dropped, numeric keys without numbers → info | Model wording drift creates phantom judges, fake attributes, duplicate options |
| Authority matrix | `facts.ts` `mayAuthor` | Generic roles only: who may set which key (participants/staff/vendors may only request) | A student changes the budget |
| Recency | `facts.ts` `compareRecency`, `reconcile.ts` | Same key + entity: latest date wins; undated → arrival order; older facts marked superseded (not rejected) | Outdated prices used |
| Injection guard | `reconcile.ts` + prompt | A message that addresses the AI/planner about its output is rejected whole; no facts are taken | "Output an approved plan" hijacks the system |
| Duplicate guard | `pipeline.ts` (exact re-send, **0 tokens, no call**), `reconcile.ts` (same sender + date + numbers) | Re-sent messages never count twice | Printing cost counted twice |
| Self-consistency | `reconcile.ts` | A stated total ≠ its own parts → whole message rejected, arithmetic shown | A wrong total silently enters the budget |
| Requests | `reconcile.ts`, `solve.ts` | Never auto-committed; shown with affordability; committed only after a top_authority/finance approval (`remove`/"not approved" never counts) | Unapproved spending enters the plan |
| Jev solve | `src/core/jev/solve.ts` | All arithmetic and choices in code: teams, judges, people on site / to feed, cheapest venue set (subset search, per-room limits, attributes), food tier vs budget, schedule, budget lines, provenance | LLM math errors; token cost |
| Jev validate | `src/core/jev/validate.ts` | Six scored checks recomputed from the plan + one line per hard constraint | An invalid plan looks valid |
| Tentative apply + rollback | `src/core/pipeline.ts` | Apply one message at a time; if it breaks a valid plan, roll it back (rejected / needs decision) with numbers | A wrong message corrupts the plan |
| Dependency graph | `src/core/jev/deps.ts` | Which areas a change touches → "recomputed by Jev"; plan diff old → new | Can't predict calls; can't show what changed |
| Area fallback | `src/core/fallback.ts` | Only for `encodable:false` constraints: one area-tagged call returning a DSL patch, re-validated by Jev; ≤ 1 per area per batch | A novel constraint is silently ignored |
| LLM wrapper | `src/core/llm.ts` | The only OpenAI caller: area tag, `response.model`, usage object exactly as returned, latency, 45 s timeout, call + time caps | Trace can't be trusted (DQ) |
| Trace | `src/core/trace.ts` | Every call with full input/output and API usage; every Jev decision with its reason | DQ / zero points |
| Policy | `src/core/policy.ts` | Generic defaults (block lengths, caps) — documented as policy, never facts | Hidden assumptions |
| Supabase mirror + UI | `src/core/store/supabase.ts`, `app/` | Judges see plan, trace and rejections live (Realtime) | UI points |

## Area tags (every model call has exactly one)

`reading` — the per-batch reading call. `venue | schedule | food | judging | budget` — only area fallback calls for a
constraint the DSL can't express, tagged with the area the constraint belongs to. A constraint that fits no plan area is
flagged for a human and **no call is made** (no dishonest tag).

## Caps (enforced in code, `policy.ts` + `CallLedger`)

| | Calls | Time |
|---|---|---|
| Full run | ≤ 5 (1 reading + 1 retry + ≤ 3 fallback) | < 110 s (hard limit 2 min) |
| Update | ≤ 4 (1 reading + 1 retry + ≤ 2 fallback) | < 55 s (hard limit 1 min) |

Per-call timeout = min(45 s, time left in the batch). When a cap is hit the fallback is skipped and flagged.

## Dependency graph

`event → all` · `venue → venue, budget` · `food → food, budget` · `judging → judging, food, venue, schedule, budget` ·
`schedule → schedule` · `budget → budget`. After every update the terminal prints the model-call areas, the areas
Jev recomputed (0 tokens), and the plan diff.

## Model

`OPENAI_MODEL=gpt-5.4-mini`, `OPENAI_REASONING_EFFORT=low` (chosen by the P0 comparison; see README). The trace
prints the `model` field from each API response (e.g. `gpt-5.4-mini-2026-03-17`) and the `usage` object verbatim,
including cached and reasoning tokens.

## Data rules

No pack facts anywhere in code, prompts, tests or comments. Official packs live in `packs/` (gitignored); the sample
pack at `fixtures/sample-pack.txt` is gitignored too. Everything in `fixtures/` is invented test data, never read by
engine code. Runtime state and outputs (`.scenebnao/`, `out/`) are gitignored, so running keeps `git status` clean.
