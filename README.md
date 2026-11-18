`npx tsx plan.ts <file>` — the one command: the first run plans the whole pack, every later run applies the new message(s) to the same plan.

# SceneBnao

Model: gpt-5.4-mini-2026-03-17 — declared as our small model (no official list, confirmed at help desk).
Configured via `OPENAI_MODEL=gpt-5.4-mini` with `OPENAI_REASONING_EFFORT=low`; the trace always prints the exact `model`
field and the `usage` object from each API response.

Hackathon planner for MTM 2.0 — live at **https://scenebnao.avezea.com**.
**The model reads, Jev decides**: one area-tagged model call turns raw messages into typed facts; Jev (deterministic
code, 0 tokens) reconciles them (authority, recency, injection, duplicates, requests), solves the plan (venue, schedule,
food, judging, budget) and validates it with six checks. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and
[docs/JUDGE-QA.md](docs/JUDGE-QA.md) (includes our model-call prediction).

## Run

```bash
npm install
npx tsx plan.ts packs/pack.txt        # first run: whole pack
npx tsx plan.ts packs/new-message.txt # every later message: same command
npx tsx reset.ts                      # start a new session
```

Any layout works (.txt, .md, .csv, .json, .eml, WhatsApp export). Empty or garbage files fail gracefully.

Outputs (gitignored, regenerated after every batch):

| File | What |
|---|---|
| `out/report.html` | **Readable report** — open in any browser: plan, changes, seating, checks, messages, trace |
| `out/plan.md` | Plan (templates only, provenance on every figure) |
| `out/plan.json` | Plan + checks + message statuses + batches |
| `out/trace.txt` | Full trace: every model call (input, raw output, API usage) and every Jev decision |
| `out/final-plan-and-trace.md` | Plan + trace, ready to upload |
| `.scenebnao/state.json` | Session state |

Web: the dashboard shows the plan, the six checks, every message with its status, rejected messages with reasons, and
the trace (CLI sessions appear live). `/report` renders the report for any session or an uploaded `.md`.

## Setup

- Secrets go in `.env` (see `.env.example`): `OPENAI_API_KEY`, `OPENAI_MODEL`, `SUPABASE_SERVICE_ROLE_KEY`;
  `vercel env pull .env.local` adds the public Supabase vars.
- Official packs never go in git: keep them in `packs/` (gitignored). `fixtures/` holds only our own invented test data.
- `npx tsx scripts/smoke.ts 0` — structural regression over the invented fixtures (20 updates, 4 layouts, edge cases).
- `npx tsx scripts/openai-smoke.ts <modelA> <modelB>` — compare candidate models on one reading call.

| Service  | Linked to |
|----------|-----------|
| GitHub   | [Muhammad-Ahsan-001/MTM_WAH_CAMPUS](https://github.com/Muhammad-Ahsan-001/MTM_WAH_CAMPUS) |
| Supabase | project `emhbqdihgbkvnaifkuno` · ap-south-1 (Mumbai) · tables: sessions, messages, model_calls, decisions, plans |
| Vercel   | `mtm-wah-campus` · Next.js · functions `bom1` · Node 24.x · scenebnao.avezea.com |
