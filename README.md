`npx tsx plan.ts <file>` — the one command: first run plans the pack, every later run applies one new message.

# SceneBnao

Model: gpt-5.4-mini-2026-03-17 — declared as our small model (no official list, confirmed at help desk).
Configured via `OPENAI_MODEL=gpt-5.4-mini` with `OPENAI_REASONING_EFFORT=low`; the trace always prints the exact `model` field from each API response.

Hackathon planner for MTM 2.0 (scenebnao.avezea.com). **The model reads, Jev decides**: one area-tagged model call turns raw
messages into typed facts; Jev (deterministic code, 0 tokens) reconciles, solves and validates the plan.

- `npx tsx reset.ts` starts a new session.
- State: `.scenebnao/state.json`. Outputs: `out/plan.md`, `out/plan.json`, `out/trace.txt`, `out/final-plan-and-trace.md` (all gitignored).
- Secrets go in `.env` (see `.env.example`). Official packs never go in git: keep them in `packs/` (gitignored); `fixtures/` holds only our own invented test data.

| Service  | Linked to |
|----------|-----------|
| GitHub   | [Muhammad-Ahsan-001/MTM_WAH_CAMPUS](https://github.com/Muhammad-Ahsan-001/MTM_WAH_CAMPUS) |
| Supabase | [MTM_WAH_CAMPUS](https://supabase.com/dashboard/project/emhbqdihgbkvnaifkuno) · ap-south-1 (Mumbai) |
| Vercel   | [mtm-wah-campus](https://vercel.com/mahsan7861100-9210s-projects/mtm-wah-campus) · Next.js · functions `bom1` · Node 24.x |
