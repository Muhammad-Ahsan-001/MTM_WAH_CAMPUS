/** File store for the CLI: state in .scenebnao/state.json, outputs in out/ (both gitignored). */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { reportHtml } from "../md-html";
import { finalMarkdown, planJson, planMarkdown } from "../render";
import { renderTraceFile } from "../trace";
import type { SessionState } from "../types";

export const STATE_DIR = ".scenebnao";
export const OUT_DIR = "out";
const STATE_FILE = join(STATE_DIR, "state.json");

export function loadState(): SessionState | null {
  if (!existsSync(STATE_FILE)) return null;
  return JSON.parse(readFileSync(STATE_FILE, "utf8")) as SessionState;
}

function atomicWrite(path: string, text: string) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}

export function saveState(state: SessionState): void {
  mkdirSync(STATE_DIR, { recursive: true });
  atomicWrite(STATE_FILE, JSON.stringify(state, null, 2));
}

export function writeOutputs(state: SessionState): void {
  mkdirSync(OUT_DIR, { recursive: true });
  atomicWrite(join(OUT_DIR, "plan.md"), planMarkdown(state));
  atomicWrite(join(OUT_DIR, "plan.json"), JSON.stringify(planJson(state), null, 2));
  atomicWrite(join(OUT_DIR, "trace.txt"), renderTraceFile(state));
  atomicWrite(join(OUT_DIR, "final-plan-and-trace.md"), finalMarkdown(state));
  atomicWrite(join(OUT_DIR, "report.html"), reportHtml(finalMarkdown(state), "SceneBnao plan"));
}

export function resetState(): void {
  rmSync(STATE_DIR, { recursive: true, force: true });
  rmSync(OUT_DIR, { recursive: true, force: true });
}
