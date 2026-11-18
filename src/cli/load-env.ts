import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * CLI only: loads KEY=VALUE pairs from .env.local then .env into process.env (Next.js loads its own).
 * Existing environment variables always win; the first file that sets a key wins.
 */
export function loadEnv(cwd: string = process.cwd()): void {
  for (const name of [".env.local", ".env"]) {
    const path = join(cwd, name);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8").replace(/^﻿/, "");
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!m) continue;
      const key = m[1];
      let value = m[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      if (value === "") continue;
      if (process.env[key] === undefined || process.env[key] === "") process.env[key] = value;
    }
  }
}
