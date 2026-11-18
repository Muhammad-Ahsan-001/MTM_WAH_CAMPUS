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
    fullRunMs: 100_000, // < 2 min hard limit (margin for process start + 3 s mirror)
    updateMs: 45_000, // < 1 min hard limit (margin for process start + 3 s mirror)
  },
  /** Policy: largest venue option set we enumerate (2^n subsets). */
  maxVenueOptions: 16,
  /** Policy: seating plan (src/core/jev/seating.ts). Generic layout choices, not facts from any pack. */
  seating: {
    /** POLICY: every room gets its own staff/registration desk; staff at the desk count toward that room's capacity. */
    staffDeskPerRoom: true,
    /** POLICY: label of the per-room staff desk. */
    deskLabel: "Staff / registration desk",
    /** POLICY: seats per team table, used only when neither participants nor team size is known. */
    seatsPerTableDefault: 4,
    /** POLICY: judges sit with/near their teams, so they take no table seat; each judge still counts once toward
     *  capacity, in the room of their first assigned team (they walk between rooms while judging). */
    judgesTakeTableSeats: false,
    /** POLICY: tables are numbered globally across rooms with this prefix (T1..Tn). */
    tablePrefix: "T",
    /** POLICY: label used for teams when no judging plan names them ("Team 1".."Team N"). */
    teamLabelPrefix: "Team ",
  },
};
