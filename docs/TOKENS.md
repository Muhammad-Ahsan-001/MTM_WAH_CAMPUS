# Token use (numbers copied from the API `usage` object)

Model: `gpt-5.4-mini` (response.model `gpt-5.4-mini-2026-03-17`), `OPENAI_REASONING_EFFORT=low`.
Measure again any time with `npx tsx scripts/bench.ts` (sequential runs; prints prompt / completion / total / reasoning
tokens and wall time per run).

## Measured (final engine, 2026-11-18 13:16, CLI `npx tsx plan.ts`)

| Run | Calls | Prompt | Completion | Reasoning | Total | Time |
|---|---|---|---|---|---|---|
| Official sample pack, first run | 1 (`reading`) | 1,603 | 2,000 | 24 | **3,603** | 10.2 s |
| Practice change (printing bill) | 1 (`reading`) | 1,775 | 224 | 100 | **1,999** | 3.3 s |
| Practice wrong message (caterer rounds down) | 1 (`reading`) | 1,768 | 244 | 121 | **2,012** | 2.5 s |
| Exact re-send of an earlier message | 0 | 0 | 0 | 0 | **0** | 0.0 s |
| 20-update adversarial chain + its pack | 20 | 45,758 | 11,360 | 4,631 | 57,118 | 86 s |

Earlier run of the same sample pack (before the last prompt edits): 4,133 total (1,530 / 2,603 / 590 reasoning).

## Why it is lean already

- One model call per batch (`reading`); every figure, choice and verdict is computed by Jev in code (0 tokens).
- Exact re-sends are detected by code before any call (0 tokens).
- A `custom` constraint whose number is already captured by another fact skips the fallback call; budget-area
  constraints have no patch keys, so they are flagged without a call.
- Reasoning effort `low`; no quality retries (only one retry, on network/parse failure).

## Planned cuts (workstream B) — not applied

The OpenAI credit balance ran out at 13:12, so no cut could be verified against the smoke suite. Per our rule, an
unverified cut does not ship. Candidates, in order of expected saving per first run:
1. Drop derivable schema fields (`area` from the key prefix, `encodable` = key is `custom`) — fewer output tokens per fact.
2. Update context with keys + entity names only (no values/dates) — smaller prompt on every update.
3. Shorter `summary` (≤ 5 words).
4. Merge prompt lines without dropping any rule.
