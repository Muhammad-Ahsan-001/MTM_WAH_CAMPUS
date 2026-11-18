/**
 * Supabase mirror (service role). Non-blocking for the CLI: 3 s timeout, failures only warn.
 * Also used by the web route as the state store for web sessions.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { SessionState } from "../types";

export function serviceClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function writeBatch(db: SupabaseClient, state: SessionState, batch: number, source: "cli" | "web"): Promise<void> {
  const sid = state.id;
  const must = (r: { error: { message: string } | null }, what: string) => {
    if (r.error) throw new Error(`${what}: ${r.error.message}`);
  };
  must(await db.from("sessions").upsert({ id: sid, label: state.label, source, state, updated_at: new Date().toISOString() }), "sessions");
  const b = state.batches.find((x) => x.batch === batch);
  const calls = state.calls.filter((c) => c.batch === batch);
  const ds = state.decisions.filter((d) => d.batch === batch);
  await Promise.all([
    (async () => must(
    await db.from("messages").upsert(
      state.messages.map((m) => ({
        session_id: sid,
        batch: m.batch,
        seq: m.seq,
        raw: [m.summary, ...m.facts.map((f) => f.evidence)].filter(Boolean).join(" | "),
        sender: m.sender,
        role: m.role,
        msg_date: m.date,
        status: m.status,
        reason: m.reason,
      })),
      { onConflict: "session_id,seq" },
    ),
    "messages",
  ))(),
    (async () => {
  if (calls.length)
    must(
      await db.from("model_calls").upsert(
        calls.map((c) => ({
          session_id: sid,
          batch: c.batch,
          seq: c.seq,
          model: c.model,
          area: c.area,
          input: `[system]\n${c.system}\n[user]\n${c.user}`,
          output: c.output,
          prompt_tokens: c.usage?.prompt_tokens ?? null,
          completion_tokens: c.usage?.completion_tokens ?? null,
          total_tokens: c.usage?.total_tokens ?? null,
          cached_tokens: c.usage?.cached_tokens ?? null,
          reasoning_tokens: c.usage?.reasoning_tokens ?? null,
          latency_ms: c.latency_ms,
        })),
        { onConflict: "session_id,seq" },
      ),
      "model_calls",
    );
    })(),
    (async () => {
  must(await db.from("decisions").delete().eq("session_id", sid).eq("batch", batch), "decisions(delete)");
  if (ds.length)
    must(
      await db.from("decisions").insert(
        ds.map((d) => ({ session_id: sid, batch, kind: d.kind, message_seq: d.ref ? Number(d.ref.replace(/\D/g, "")) || null : null, area: d.area ?? null, reason: d.reason })),
      ),
      "decisions",
    );
    })(),
    (async () => {
  if (state.plan && b)
    must(
      await db.from("plans").upsert(
        { session_id: sid, version: state.plan_version, plan: state.plan, checks: state.checks, areas_called: b.areas_called, areas_recomputed: b.areas_recomputed, diff: b.diff },
        { onConflict: "session_id,version" },
      ),
      "plans",
    );
    })(),
  ]);
}

/** Opens the TLS connection early (while the model call runs) so the post-batch mirror fits its 3 s budget. */
export function warmUp(): Promise<void> {
  const db = serviceClient();
  if (!db) return Promise.resolve();
  return Promise.resolve(db.from("sessions").select("id").limit(1)).then(
    () => undefined,
    () => undefined,
  );
}

/** Returns true on success, or a short reason string. Never throws. */
export async function mirrorToSupabase(state: SessionState, batch: number, source: "cli" | "web", timeoutMs = 3000): Promise<true | string> {
  const db = serviceClient();
  if (!db) return "NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set";
  try {
    await Promise.race([
      writeBatch(db, state, batch, source),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout after ${timeoutMs} ms`)), timeoutMs)),
    ]);
    return true;
  } catch (e) {
    return (e as Error).message;
  }
}
