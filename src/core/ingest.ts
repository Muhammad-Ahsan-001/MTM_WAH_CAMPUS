/**
 * Ingest: read the input file exactly as given (UTF-8; only a BOM is stripped). Any layout or extension.
 * Messages are NOT split here — the reading call segments them.
 */
import { readFileSync, statSync } from "node:fs";

export class IngestError extends Error {}

const MAX_BYTES = 512 * 1024;

export function decode(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString("utf8");
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString("utf16le"); // UTF-16 LE export
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2));
    swapped.swap16();
    return swapped.toString("utf16le");
  }
  return buf.toString("utf8");
}

export function checkReadable(text: string): void {
  if (!text.trim()) throw new IngestError("input is empty — nothing to plan");
  const letters = (text.match(/[\p{L}\p{N}]/gu) ?? []).length;
  const words = (text.match(/\p{L}{3,}/gu) ?? []).length;
  if (words < 3 || letters / text.replace(/\s/g, "").length < 0.5) throw new IngestError("input has no readable message text (looks like garbage or binary)");
}

export function ingestFile(path: string): string {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    throw new IngestError(`file not found: ${path}`);
  }
  if (size > MAX_BYTES) throw new IngestError(`file is ${Math.round(size / 1024)} KB; limit ${MAX_BYTES / 1024} KB`);
  const text = decode(readFileSync(path));
  checkReadable(text);
  return text;
}
