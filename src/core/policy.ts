/**
 * Generic planning defaults. These are POLICY (our choices), not facts from any pack.
 * Every value here is used only when the messages do not state the figure themselves.
 */
export const POLICY = {
  /** Policy: the brief says a 4-hour physical hackathon. Used only if no duration/start+end is stated. */
  defaultDurationMin: 240,
  /** Policy: opening/briefing block length. */
  openingMin: 15,
  /** Policy: lunch block length, scheduled only when food is planned. */
  lunchMin: 30,
  /** Policy: closing/awards block length. */
  closingMin: 15,
  /** Policy: minimum build time we accept as a sane schedule. */
  minBuildMin: 30,
  /** Policy: one judge per team unless a message requires more. */
  judgesPerTeam: 1,
  /** Policy: preferred food tier labels, in order. */
  standardTierLabels: ["standard", "regular", "default", "normal", "basic"],
  /** Policy: a percent reserve/tax applies to the subtotal of spending. */
  percentBase: "subtotal" as const,
  /** Policy: hard caps on model calls. */
  caps: {
    fullRunCalls: 5, // 1 reading + 1 retry + up to 3 fallback
    updateCalls: 4, // 1 reading + 1 retry + up to 2 fallback
    fallbackPerAreaPerBatch: 1,
    fullRunMs: 110_000, // < 2 min hard limit
    updateMs: 55_000, // < 1 min hard limit
  },
  /** Policy: largest venue option set we enumerate (2^n subsets). */
  maxVenueOptions: 16,
};
