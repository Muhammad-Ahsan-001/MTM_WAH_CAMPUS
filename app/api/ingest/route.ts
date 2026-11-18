/**
 * POST /api/ingest — the same core pipeline as the CLI, with Supabase as the state store.
 * Body: multipart (file or text, optional session_id) or JSON { text, session_id?, file_name? }.
 */
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { IngestError, checkReadable, decode } from "../../../src/core/ingest";
import { newSession, runBatch } from "../../../src/core/pipeline";
import { serviceClient, writeBatch } from "../../../src/core/store/supabase";
import type { SessionState } from "../../../src/core/types";

export const runtime = "nodejs";
export const maxDuration = 120; // same caps as the CLI are enforced inside the pipeline
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let text = "";
  let fileName = "web-input.txt";
  let sessionId: string | null = null;
  try {
    const type = req.headers.get("content-type") ?? "";
    if (type.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      if (file && typeof file !== "string") {
        text = decode(Buffer.from(await file.arrayBuffer()));
        fileName = file.name || fileName;
      } else text = String(form.get("text") ?? "");
      sessionId = (form.get("session_id") as string) || null;
    } else {
      const body = await req.json();
      text = String(body.text ?? "");
      fileName = body.file_name || fileName;
      sessionId = body.session_id || null;
    }
    if (text.length > 64 * 1024) throw new IngestError("input over 64 KB — too large for one batch");
    checkReadable(text);
  } catch (e) {
    const msg = e instanceof IngestError ? e.message : `bad request: ${(e as Error).message}`;
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "server missing SUPABASE_SERVICE_ROLE_KEY / NEXT_PUBLIC_SUPABASE_URL" }, { status: 500 });
  if (!process.env.OPENAI_API_KEY || !process.env.OPENAI_MODEL) return NextResponse.json({ error: "server missing OPENAI_API_KEY / OPENAI_MODEL" }, { status: 500 });

  let state: SessionState;
  if (sessionId) {
    const { data, error } = await db.from("sessions").select("source,state").eq("id", sessionId).maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data) return NextResponse.json({ error: "session not found" }, { status: 404 });
    if (data.source === "cli") return NextResponse.json({ error: "CLI sessions are read-only in the web UI" }, { status: 403 });
    state = data.state as SessionState;
  } else {
    state = newSession(`web ${new Date().toISOString().slice(0, 16).replace("T", " ")}`, randomUUID());
  }

  const res = await runBatch(state, text, fileName);
  try {
    await writeBatch(db, state, res.batch.batch, "web");
  } catch (e) {
    return NextResponse.json({ error: `saved plan but mirror failed: ${(e as Error).message}`, session_id: state.id }, { status: 500 });
  }
  return NextResponse.json({ session_id: state.id, batch: res.batch });
}
