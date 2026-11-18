/**
 * Markdown -> safe HTML for the subset our plan renderer emits: #..###### headings (with id slugs),
 * paragraphs, "- " / "1. " lists, GFM pipe tables, fenced code, **bold**, _italic_, `code`.
 * Pure and dependency-free (runs in Node and the browser).
 *
 * SECURITY: the input is untrusted (it quotes user-supplied messages). Every piece of text is
 * HTML-escaped BEFORE any markup is added, raw HTML is never passed through, and links/images are
 * not supported, so no URL or attribute can be injected. Callers rely on this when they use
 * dangerouslySetInnerHTML on the output — keep it that way.
 */

export type TocEntry = { level: number; text: string; id: string };

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC[c]);
}

const FENCE_OPEN = /^\s{0,3}`{3,}(.*)$/;
const FENCE_CLOSE = /^\s{0,3}`{3,}\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const UL = /^\s*[-*+]\s+(.*)$/;
const OL = /^\s*\d{1,9}[.)]\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const FROM = /\s*_\(from [^)]*\)_/g;

// ---------- inline ----------
function italic(body: string): string {
  // `_(from m2, m4)_` is provenance -> grey pill chip. `body` is already escaped.
  const m = /^\(from ([^()]+)\)$/.exec(body);
  if (m) return `<span class="md-from" title="Taken from message(s) ${m[1]}">from ${m[1]}</span>`;
  return `<em>${body}</em>`;
}

function inline(src: string): string {
  const codes: string[] = [];
  // Pull code spans out first (escaped), so their contents are never formatted.
  let s = src.replace(/`([^`]+)`/g, (_, c: string) => {
    codes.push(`<code>${escapeHtml(c)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = escapeHtml(s);
  // Formatting is applied to escaped text: only our own fixed tags are ever introduced.
  s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>");
  // Underscore italics only at word boundaries, so snake_case words (backup_power) stay intact.
  s = s.replace(/(^|[^A-Za-z0-9_])_(?=\S)([^_]*?\S)_(?![A-Za-z0-9_])/g, (_, pre: string, body: string) => pre + italic(body));
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => codes[Number(i)] ?? "");
}

function plainText(src: string): string {
  return src
    .replace(FROM, "")
    .replace(/\*\*|`/g, "")
    .replace(/(^|\s)_(\S)/g, "$1$2")
    .replace(/(\S)_(\s|$)/g, "$1$2")
    .trim();
}

function tint(text: string): string {
  const t = text.trimStart();
  if (t.startsWith("✅")) return "md-ok";
  if (t.startsWith("❌")) return "md-bad";
  if (t.startsWith("⚠")) return "md-warn";
  return "";
}
const cls = (c: string) => (c ? ` class="${c}"` : "");

// ---------- tables ----------
function cells(row: string): string[] {
  let s = row.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}
function alignOf(sep: string): "" | "left" | "right" | "center" {
  const t = sep.trim();
  const l = t.startsWith(":");
  const r = t.endsWith(":");
  return l && r ? "center" : r ? "right" : l ? "left" : "";
}
const NUM = /^(?:Rs\.?\s*|₹\s*)?[-−+]?\d[\d,]*(?:\.\d+)?(?:\s*(?:min|%))?$/i;
const EMPTYISH = /^(?:—|–|-|n\/a)?$/i;
const cellPlain = (c: string) => plainText(c);

function table(headerLine: string, sepLine: string, rowLines: string[]): string {
  const head = cells(headerLine);
  const n = head.length;
  const explicit = cells(sepLine).map(alignOf);
  const rows = rowLines.map((l) => {
    const r = cells(l).slice(0, n);
    while (r.length < n) r.push("");
    return r;
  });
  const colCls = head.map((_, k) => {
    const a = explicit[k] ?? "";
    if (a) return `al-${a}`;
    const vals = rows.map((r) => cellPlain(r[k]));
    const numeric = vals.some((v) => NUM.test(v)) && vals.every((v) => NUM.test(v) || EMPTYISH.test(v));
    return numeric ? "num" : "";
  });
  const th = head.map((h, k) => `<th${cls(colCls[k])}>${inline(h)}</th>`).join("");
  const body = rows
    .map((r) => {
      const filled = r.filter((c) => c);
      const strong = filled.length > 0 && filled.every((c) => /^\*\*[\s\S]+\*\*$/.test(c));
      return `<tr${cls(strong ? "md-strong-row" : "")}>${r.map((c, k) => `<td${cls(colCls[k])}>${inline(c)}</td>`).join("")}</tr>`;
    })
    .join("\n");
  return `<div class="md-table-wrap"><table><thead><tr>${th}</tr></thead><tbody>\n${body}\n</tbody></table></div>`;
}

// ---------- blocks ----------
function isTableStart(lines: string[], i: number): boolean {
  return lines[i].includes("|") && i + 1 < lines.length && lines[i + 1].includes("|") && TABLE_SEP.test(lines[i + 1]);
}
function isBlockStart(lines: string[], i: number): boolean {
  const l = lines[i];
  return !l.trim() || FENCE_OPEN.test(l) || HEADING.test(l) || HR.test(l) || UL.test(l) || OL.test(l) || isTableStart(lines, i);
}

function slugger() {
  const used = new Map<string, number>();
  return (text: string) => {
    const base =
      text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "section";
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    return n ? `${base}-${n + 1}` : base;
  };
}

/** Converts Markdown to safe HTML and returns the headings (for a table of contents). */
export function mdRender(md: string): { html: string; toc: TocEntry[] } {
  const lines = md.replace(/\u0000/g, "").replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  const toc: TocEntry[] = [];
  const slug = slugger();
  let section = "";
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    // fenced code
    const f = FENCE_OPEN.exec(line);
    if (f) {
      const isTrace = section.toLowerCase() === "trace";
      let end = -1;
      if (isTrace) {
        // The trace quotes raw model output, which may contain its own ``` lines: close at the LAST fence.
        for (let j = lines.length - 1; j > i; j--) {
          if (FENCE_CLOSE.test(lines[j])) {
            end = j;
            break;
          }
        }
      } else {
        for (let j = i + 1; j < lines.length; j++) {
          if (FENCE_CLOSE.test(lines[j])) {
            end = j;
            break;
          }
        }
      }
      if (end < 0) end = lines.length;
      const body = lines.slice(i + 1, end);
      const lang = (f[1] ?? "").trim().split(/\s+/)[0].replace(/[^A-Za-z0-9_+-]/g, "");
      const pre = `<pre${cls(lang ? `language-${lang}` : "")}><code>${escapeHtml(body.join("\n"))}</code></pre>`;
      out.push(isTrace ? `<details class="md-trace"><summary>Show full trace (${body.length.toLocaleString("en-US")} lines)</summary>${pre}</details>` : pre);
      i = end + 1;
      continue;
    }

    // heading
    const h = HEADING.exec(line);
    if (h) {
      const level = h[1].length;
      const raw = h[2].replace(/\s+#+\s*$/, "").trim();
      const text = plainText(raw);
      const id = slug(text);
      section = text;
      if (level === 2) toc.push({ level, text, id });
      out.push(`<h${level} id="${id}">${inline(raw)}</h${level}>`);
      i++;
      continue;
    }

    if (HR.test(line)) {
      out.push("<hr>");
      i++;
      continue;
    }

    // table
    if (isTableStart(lines, i)) {
      const lead = line.trim().startsWith("|");
      let j = i + 2;
      const rows: string[] = [];
      while (j < lines.length && lines[j].trim() && (lead ? lines[j].trim().startsWith("|") : lines[j].includes("|"))) rows.push(lines[j++]);
      out.push(table(line, lines[i + 1], rows));
      i = j;
      continue;
    }

    // lists
    const listRe = UL.test(line) ? UL : OL.test(line) ? OL : null;
    if (listRe) {
      const tag = listRe === UL ? "ul" : "ol";
      const items: string[][] = [];
      while (i < lines.length) {
        const m = listRe.exec(lines[i]);
        if (m) items.push([m[1]]);
        else if (items.length && /^\s{2,}\S/.test(lines[i]) && !isBlockStart(lines, i)) items[items.length - 1].push(lines[i].trim());
        else break;
        i++;
      }
      out.push(`<${tag}>\n${items.map((it) => `<li${cls(tint(it[0]))}>${it.map(inline).join("<br>")}</li>`).join("\n")}\n</${tag}>`);
      continue;
    }

    // paragraph
    const para: string[] = [line];
    i++;
    while (i < lines.length && !isBlockStart(lines, i)) para.push(lines[i++]);
    out.push(`<p${cls(tint(para[0]))}>${para.map(inline).join("<br>\n")}</p>`);
  }
  return { html: out.join("\n"), toc };
}

/** Converts the plan-renderer Markdown subset to safe (fully escaped) HTML. */
export function mdToHtml(md: string): string {
  return mdRender(md).html;
}

/** `<div class="md-report">` with a contents list (from the ## headings) placed before the first ## section. */
export function reportBodyHtml(md: string): string {
  const { html, toc } = mdRender(md);
  if (!toc.length) return `<div class="md-report">${html}</div>`;
  const nav = `<nav class="md-toc" aria-label="Contents"><div class="md-toc-title">Contents</div><ol>${toc
    .map((t) => `<li><a href="#${t.id}">${escapeHtml(t.text)}</a></li>`)
    .join("")}</ol></nav>`;
  const at = html.indexOf("<h2 ");
  return `<div class="md-report">${at >= 0 ? html.slice(0, at) + nav + "\n" + html.slice(at) : nav + html}</div>`;
}

/** Styles for `.md-report` content (scoped, light theme, print-ready). Safe to inject into any page. */
export const REPORT_CSS = `
.md-report{color:#1e293b;font-size:15px;line-height:1.6;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;overflow-wrap:break-word}
.md-report h1{font-size:26px;line-height:1.25;font-weight:800;color:#0f172a;margin:0 0 10px;letter-spacing:-.01em}
.md-report h2{font-size:19px;line-height:1.3;font-weight:700;color:#0f172a;margin:30px 0 10px;padding-bottom:6px;border-bottom:2px solid #e2e8f0;scroll-margin-top:16px}
.md-report h3{font-size:16px;font-weight:700;color:#334155;margin:20px 0 8px;scroll-margin-top:16px}
.md-report h4,.md-report h5,.md-report h6{font-size:15px;font-weight:700;color:#334155;margin:16px 0 6px}
.md-report p{margin:8px 0}
.md-report strong{font-weight:700;color:#0f172a}
.md-report em{font-style:italic}
.md-report hr{border:0;border-top:1px solid #e2e8f0;margin:20px 0}
.md-report ul,.md-report ol{margin:8px 0;padding-left:22px}
.md-report li{margin:3px 0}
.md-report li.md-ok,.md-report li.md-bad,.md-report li.md-warn{list-style:none;margin:4px 0 4px -22px;padding:4px 10px;border-radius:6px;border-left:4px solid}
.md-report .md-ok{background:#ecfdf5;border-color:#10b981;color:#064e3b}
.md-report .md-bad{background:#fef2f2;border-color:#ef4444;color:#7f1d1d}
.md-report .md-warn{background:#fffbeb;border-color:#f59e0b;color:#78350f}
.md-report p.md-ok,.md-report p.md-bad,.md-report p.md-warn{padding:6px 10px;border-radius:6px;border-left:4px solid}
.md-report code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.88em;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:4px;padding:0 4px}
.md-report pre{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px 14px;margin:10px 0;overflow:auto;font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-word;color:#0f172a}
.md-report pre code{background:none;border:0;padding:0;font-size:inherit}
.md-report .md-from{display:inline-block;margin-left:5px;padding:0 7px;border:1px solid #e2e8f0;border-radius:999px;background:#f1f5f9;color:#64748b;font-size:11px;font-weight:600;font-style:normal;line-height:18px;vertical-align:1px;white-space:nowrap}
.md-report .md-table-wrap{overflow-x:auto;margin:10px 0}
.md-report table{border-collapse:collapse;width:100%;font-size:14px}
.md-report th,.md-report td{border:1px solid #cbd5e1;padding:6px 10px;text-align:left;vertical-align:top}
.md-report thead th{background:#f1f5f9;font-weight:700;color:#0f172a}
.md-report tbody tr:nth-child(even){background:#f8fafc}
.md-report tr.md-strong-row{background:#eef2ff}
.md-report .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.md-report .al-right{text-align:right}
.md-report .al-center{text-align:center}
.md-report .md-toc{border:1px solid #e2e8f0;background:#f8fafc;border-radius:10px;padding:10px 14px;margin:16px 0 8px}
.md-report .md-toc-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#64748b;margin-bottom:4px}
.md-report .md-toc ol{display:flex;flex-wrap:wrap;gap:2px 18px;list-style:none;margin:0;padding:0}
.md-report .md-toc li{margin:0}
.md-report .md-toc a{color:#3730a3;font-weight:600;text-decoration:none}
.md-report .md-toc a:hover{text-decoration:underline}
.md-report details.md-trace{border:1px solid #cbd5e1;border-radius:8px;margin:10px 0;background:#fff}
.md-report details.md-trace>summary{cursor:pointer;padding:8px 12px;font-weight:600;color:#334155;background:#f8fafc;border-radius:8px}
.md-report details.md-trace[open]>summary{border-bottom:1px solid #e2e8f0;border-radius:8px 8px 0 0}
.md-report details.md-trace pre{margin:0;border:0;border-radius:0 0 8px 8px;max-height:70vh}
@media print{
  @page{size:A4;margin:14mm 12mm}
  .md-report{font-size:10.5pt;color:#000;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .md-report a,.md-report .md-toc a{color:inherit;text-decoration:none}
  .md-report h1,.md-report h2,.md-report h3{break-after:avoid;page-break-after:avoid}
  .md-report table,.md-report .md-toc{break-inside:avoid;page-break-inside:avoid}
  .md-report tr,.md-report li{break-inside:avoid;page-break-inside:avoid}
  .md-report thead{display:table-header-group}
  .md-report .md-table-wrap{overflow:visible}
  .md-report pre,.md-report details.md-trace pre{max-height:none;overflow:visible;font-size:8pt}
  .md-report table{font-size:9.5pt}
}
`;

const DOC_CSS = `
*{box-sizing:border-box}
html{background:#fff;color-scheme:light}
body{margin:0;background:#fff;color:#1e293b}
.md-page{max-width:1000px;margin:0 auto;padding:32px 24px 48px}
.md-foot{margin-top:36px;padding-top:10px;border-top:1px solid #e2e8f0;font:12px/1.5 ui-sans-serif,system-ui,sans-serif;color:#64748b}
@media print{.md-page{max-width:none;padding:0}}
`;

/** A complete standalone HTML document (inline styles only, no external assets, scripts blocked by CSP). */
export function reportHtml(md: string, title: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<title>${escapeHtml(title)}</title>
<style>${DOC_CSS}${REPORT_CSS}</style>
</head>
<body>
<main class="md-page">
${reportBodyHtml(md)}
<p class="md-foot">${escapeHtml(title)} · generated by SceneBnao. Every figure is computed by code; grey chips show the messages it came from.</p>
</main>
</body>
</html>
`;
}
