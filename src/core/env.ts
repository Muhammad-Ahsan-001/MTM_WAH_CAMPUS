/** Environment access shared by CLI and web (no filesystem access here; see src/cli/load-env.ts). */
export function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing ${key}. Put it in .env (see .env.example).`);
  return v;
}
