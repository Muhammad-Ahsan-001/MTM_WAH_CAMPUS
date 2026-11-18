/** npx tsx reset.ts — start a new session (session control, not message input). */
import { resetState } from "./src/core/store/file";

resetState();
console.log("Session cleared. Next `npx tsx plan.ts <file>` starts a new session.");
