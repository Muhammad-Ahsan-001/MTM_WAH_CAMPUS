# Judge Q&A — what each part does and what breaks without it

**Q: Where does the plan come from?** From code. The model only emits typed facts (key, entity, number, unit, evidence).
Jev (`src/core/jev/`) computes every figure and choice and validates it. No model writes plan prose; templates render it.

**Q: How many model calls per batch, and why?** One `reading` call per batch. Extra calls happen only for a constraint
our vocabulary can't express (`encodable:false`): one call tagged with that constraint's area (venue/schedule/food/
judging/budget), at most one per area per batch. An exact re-send of earlier text makes **zero** calls (code detects it).

**Q: Are model name and tokens real?** Yes. `src/core/llm.ts` copies `response.model` and the `usage` object exactly as
returned (prompt, completion, total, cached, reasoning). Nothing is estimated or relabelled. The trace shows full input
and raw output for every call.

**Q: How do you catch a wrong message?** Layered code checks, each with a reason in the trace:
- injection / instructions to the AI → rejected whole, no facts taken;
- unauthorized role (e.g. a participant setting the budget) → rejected: `role X may not set Y`;
- older-dated value → superseded, the newer value kept;
- supplier quantity below what we must feed → rejected, order stays at the requirement (both numbers shown);
- a stated total that doesn't match its own parts → rejected with the arithmetic;
- anything that would turn a valid plan invalid → rolled back and held for a human, with the exact shortfall.

**Q: What if an authoritative change is infeasible?** We keep the last valid plan, mark the message
`needs human decision`, and print the shortfall. We never present an invalid plan as valid.

**Q: What happens to requests for money?** Listed under Requests with `affordable: yes/no (remaining Rs X)`; committed only
after an approval from top_authority or finance. "Not approved" is parsed as a negation and never counts as approval.

**Q: What breaks without the authority matrix?** Any sender could change any figure. **Without recency?** Old prices win.
**Without the validator?** A plan could silently exceed the budget or overfill a room. **Without rollback?** One wrong
message corrupts the plan for every later update. **Without the dependency graph?** We couldn't say which areas changed or
predict calls. **Without the fallback?** A new constraint type would be silently ignored.

**Q: Why not let the model do the math?** LLM arithmetic is unreliable and costs tokens; code is exact and free.

**Q: How is the venue chosen?** Enumerate every subset of available options (respecting max rooms, per-room limits and
required attributes), keep those with capacity ≥ people on site, pick the cheapest; tie-break fewer rooms, then more
headroom. A required attribute that no option mentions at all can't be checked from venue data, so it becomes an
organiser action item (shown with ⚠), not a venue filter.

**Q: How is food chosen?** The tier labelled standard/regular/default if the whole plan fits the budget; otherwise the
cheapest tier that fits, with the reason logged. Quantity always equals people to feed (participants + staff + judges
used + groups the organiser says to feed).

**Q: How is the schedule built?** Opening, lunch (if food), judging window (load × minutes per team, rounded up to 5 min),
closing, plus required blocks from messages; build time absorbs the rest so the total equals the duration exactly. A block
is pinned to a clock time only if that time appears in the message's own evidence.

**Q: Judges?** judges_needed = ceil(teams × judges_per_team / max_teams_per_judge); if the judging window doesn't fit the
schedule we add judges (up to those available). Round-robin assignment table, checked for load and distinct judges per team.

**Q: How does an update stay cheap?** The reading call gets a compact CURRENT FACTS index so the model reuses keys and
entity names; Jev recomputes everything else in code. Typical update: 1 call, 2–6 s.

**Q: What keeps git clean?** All state and outputs go to `.scenebnao/` and `out/`, both gitignored. Packs never enter git.

## Event Kit (web extras, zero tokens)

None of these features call a model or appear in the trace. They never run in the CLI, and they never change
plan.json, the checks or the engine.

- **Group messages:** turns the live plan into ready-to-send WhatsApp messages in English and Roman Urdu (schedule,
  venue, lunch, judging rules, repo submission, organiser budget). *Zero tokens:* hand-written templates filled with
  plan numbers and organiser inputs.
- **Update broadcast:** after each accepted change, drafts the group message from the plan diff ("Update: …"). For a
  rejected message it shows "Not broadcast: mX was rejected — reason". *Zero tokens:* the diff is computed by Jev and
  the wording comes from templates.
- **2D seating planner:** lays out each room's tables from the plan, seats teams, and merges neighbouring desks when a
  table type runs out. It reports every merge, empty seat and unseated team. *Zero tokens:* plain grid code.
- **Print pack:** A4 door and room attendance sheets, plus table patches with a QR code to the submission form.
  *Zero tokens:* print templates and a client-side QR library.
- **Readable report (`/report`, `out/report.html`):** the plan Markdown rendered as a clean page.
  *Zero tokens:* escaped Markdown→HTML conversion in code.

## Model-call prediction (scored: prediction vs reality)

| Batch | Predicted model-call areas |
|---|---|
| Unseen pack (first run) | `reading` ×1. Plus one call per area **only** if the pack contains a constraint type outside our vocabulary (rare; ≤ 3). |
| Each of the 3 later messages | `reading` ×1. A change to existing facts (price, headcount, budget, venue availability, judges) needs no other call — Jev recomputes. |
| A message with a never-seen constraint type | `reading` + 1 call tagged with that constraint's area. |
| An exact re-send | none (0 calls). |
| The wrong message | `reading` ×1 only; it is rejected by code. |
