// `frame render [<path>]` — write a static index.html that visualizes
// the frame(s) at the given path. Single frame writes ./index.html with
// an entity table + evidence. Multi-frame parent writes one root index
// linking to each frame's render.
//
// No server, no JS, no daemon. Open with file:// or any static server.

import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Frame } from "../frame.js";
import { FrameError, type FrameSchema, type Source } from "../types.js";
import { splitPathAndFlags } from "./util.js";

const SKIP_DIRS = new Set([".git", ".frame", "node_modules", "dist"]);

function findFrames(rootDir: string, includeRoot: boolean): string[] {
  const out: string[] = [];
  function walk(dir: string, depth: number): void {
    if (depth > 6) return;
    if (existsSync(join(dir, "schema.yml"))) {
      if (dir !== rootDir || includeRoot) out.push(dir);
    }
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.startsWith(".") || SKIP_DIRS.has(entry)) continue;
      const child = join(dir, entry);
      try {
        if (statSync(child).isDirectory()) walk(child, depth + 1);
      } catch {}
    }
  }
  walk(rootDir, 0);
  return out;
}

export function render(args: string[]): void {
  const { path } = splitPathAndFlags(args);
  const rootDir = path
    ? (path.startsWith("/") ? path : join(process.cwd(), path))
    : process.cwd();

  const cwdIsFrame = existsSync(join(rootDir, "schema.yml"));
  const nestedFrames = findFrames(rootDir, false);

  if (!cwdIsFrame && nestedFrames.length === 0) {
    throw new FrameError(
      "NoFramesFound",
      `No schema.yml here or in subdirectories of ${rootDir}.`,
    );
  }

  const written: string[] = [];

  // Render every frame found.
  const allFrames = cwdIsFrame ? [rootDir, ...nestedFrames] : nestedFrames;
  const summaries: Array<{ dir: string; relPath: string; schema: FrameSchema; entityCount: number }> = [];

  for (const dir of allFrames) {
    const frame = new Frame(dir);
    const schema = frame.schema();
    const result = frame.query({ mode: "all", include_sources: true });
    const html = renderFrame(schema, result.rows);
    const out = join(dir, "index.html");
    writeFileSync(out, html);
    written.push(out);
    summaries.push({
      dir,
      relPath: dir === rootDir ? "." : relative(rootDir, dir),
      schema,
      entityCount: result.rows.length,
    });
  }

  // Multi-frame parent gets a root index too (overwrites the single-frame one
  // if the cwd is itself a frame — that's fine; it points to itself).
  if (allFrames.length > 1) {
    const indexHtml = renderIndex(summaries);
    const out = join(rootDir, "index.html");
    writeFileSync(out, indexHtml);
    if (!written.includes(out)) written.push(out);
  }

  console.log(`◇ rendered ${written.length} ${written.length === 1 ? "page" : "pages"}`);
  for (const w of written) console.log(`  ${w}`);
  console.log();
  console.log(`Open the root with:`);
  console.log(`  open ${join(rootDir, "index.html")}`);
}

// ─── HTML ────────────────────────────────────────────────────────────────────

const CSS = `
:root { color-scheme: light dark; }
body { font: 14px/1.55 ui-sans-serif, system-ui, -apple-system, sans-serif; max-width: 1100px; margin: 2.5rem auto; padding: 0 1.25rem; }
h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
h2 { font-size: 1rem; margin: 2.25rem 0 .5rem; color: var(--muted, #555); text-transform: uppercase; letter-spacing: .05em; }
header { border-bottom: 1px solid #eee5; padding-bottom: 1rem; margin-bottom: 1rem; }
header p { margin: .25rem 0; color: #555; max-width: 60ch; }
a { color: #0366d6; text-decoration: none; }
a:hover { text-decoration: underline; }
code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.muted { color: #888; }
.pill { display: inline-block; font-size: 11px; padding: 2px 8px; border-radius: 9px; background: #eee5; color: #555; margin-left: .5rem; vertical-align: 2px; }
.stats { display: flex; gap: 1.5rem; margin-top: .5rem; color: #555; font-size: 13px; flex-wrap: wrap; }
.stats b { color: inherit; font-variant-numeric: tabular-nums; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { text-align: left; padding: .45rem .65rem; border-bottom: 1px solid #eee5; vertical-align: top; }
th { color: #555; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; background: rgba(0,0,0,.015); position: sticky; top: 0; }
tr:hover td { background: rgba(0,0,0,.02); }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.invalid { background: rgba(255, 0, 0, .04); }
.src { opacity: .55; font-size: 11px; margin-left: .25rem; }
.src:hover { opacity: 1; }
details { margin-top: 1rem; }
details summary { cursor: pointer; color: #555; font-size: 12px; }
.evidence { font-size: 12px; color: #555; padding: .5rem 0 .5rem 1rem; border-left: 2px solid #eee5; margin: .5rem 0 1rem; }
.evidence b { color: inherit; }
.evidence p { margin: .15rem 0; }
footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid #eee5; color: #888; font-size: 12px; }
@media (prefers-color-scheme: dark) {
  body { background: #0d1117; color: #e6edf3; }
  header, footer { border-color: #30363d; }
  th { background: rgba(255,255,255,.025); }
  th, .muted, .stats, header p, details summary, .evidence { color: #8b949e; }
  tr:hover td { background: rgba(255,255,255,.03); }
  .pill { background: #30363d; color: #c9d1d9; }
  a { color: #58a6ff; }
}
`;

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function renderFrame(schema: FrameSchema, rows: Array<{ entity_id: string; fields: Record<string, unknown>; sources?: Record<string, Source>; invalid?: { reason: string }[] }>): string {
  const fields = Object.keys(schema.fields);
  const desc = schema.description?.trim() ?? "";
  const invalidCount = rows.filter((r) => r.invalid && r.invalid.length > 0).length;

  const tableRows = rows.map((row) => {
    const cells = fields.map((f) => {
      const value = row.fields[f];
      const source = row.sources?.[f];
      const display = value === undefined
        ? `<span class="muted">—</span>`
        : esc(String(value));
      const srcLink = source
        ? ` <a href="${esc(source.url)}" class="src" title="${esc(source.excerpt ?? source.url)}" target="_blank" rel="noreferrer">↗</a>`
        : "";
      return `<td>${display}${srcLink}</td>`;
    }).join("");
    const klass = row.invalid && row.invalid.length > 0 ? ' class="invalid"' : "";
    return `<tr${klass}>
        <td><code>${esc(row.entity_id)}</code></td>
        ${cells}
      </tr>`;
  }).join("\n      ");

  const evidenceBlocks = rows.filter((r) => r.sources).map((row) => {
    const items = fields.map((f) => {
      const source = row.sources?.[f];
      if (!source) return null;
      return `<p><b>${esc(f)}</b> · <a href="${esc(source.url)}" target="_blank" rel="noreferrer">${esc(source.url)}</a>${source.excerpt ? `<br><span class="muted">"${esc(source.excerpt)}"</span>` : ""}</p>`;
    }).filter(Boolean).join("\n        ");
    if (!items) return "";
    return `<div class="evidence"><b>${esc(row.entity_id)}</b>\n        ${items}\n      </div>`;
  }).filter(Boolean).join("\n      ");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${esc(schema.name)} — frame</title>
  <style>${CSS}</style>
</head>
<body>
  <header>
    <h1>${esc(schema.name)} <span class="pill">${esc(schema.entity_type ?? "entity")}</span></h1>
    ${desc ? `<p>${esc(desc)}</p>` : ""}
    <div class="stats">
      <span><b>${rows.length}</b> entities</span>
      <span><b>${fields.length}</b> fields</span>
      ${invalidCount > 0 ? `<span style="color:#c00"><b>${invalidCount}</b> invalid</span>` : ""}
      <span class="muted">protocol ${esc(schema.frame_protocol)}</span>
    </div>
  </header>

  <h2>Entities (${rows.length})</h2>
  <table>
    <thead>
      <tr>
        <th>id</th>
        ${fields.map((f) => `<th>${esc(f)}</th>`).join("\n        ")}
      </tr>
    </thead>
    <tbody>
      ${tableRows || `<tr><td colspan="${fields.length + 1}" class="muted">no entities yet</td></tr>`}
    </tbody>
  </table>

  ${evidenceBlocks ? `<details>
    <summary>Evidence (${rows.filter((r) => r.sources).length} entities sourced)</summary>
    <div style="margin-top: 1rem">
      ${evidenceBlocks}
    </div>
  </details>` : ""}

  <footer>
    generated ${esc(new Date().toISOString())} ·
    <a href="schema.yml">schema.yml</a> ·
    <a href="events.ndjson">events.ndjson</a> ·
    <a href="README.md">README.md</a>
  </footer>
</body>
</html>
`;
}

function renderIndex(
  summaries: Array<{ relPath: string; schema: FrameSchema; entityCount: number }>,
): string {
  const totalEntities = summaries.reduce((n, s) => n + s.entityCount, 0);
  const rows = summaries.map((s) => {
    const desc = (s.schema.description ?? "").split("\n")[0]?.trim() ?? "";
    const linkPath = s.relPath === "." ? "index.html" : `${s.relPath}/index.html`;
    return `<tr>
        <td><a href="${esc(linkPath)}"><code>${esc(s.schema.name)}</code></a></td>
        <td class="muted">${esc(s.relPath)}</td>
        <td>${esc(desc)}</td>
        <td class="num">${s.entityCount}</td>
      </tr>`;
  }).join("\n      ");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>frames</title>
  <style>${CSS}</style>
</head>
<body>
  <header>
    <h1>frames</h1>
    <div class="stats">
      <span><b>${summaries.length}</b> ${summaries.length === 1 ? "frame" : "frames"}</span>
      <span><b>${totalEntities}</b> entities total</span>
    </div>
  </header>

  <h2>Frames (${summaries.length})</h2>
  <table>
    <thead>
      <tr>
        <th>name</th>
        <th>path</th>
        <th>description</th>
        <th class="num">entities</th>
      </tr>
    </thead>
    <tbody>
      ${rows || `<tr><td colspan="4" class="muted">no frames found</td></tr>`}
    </tbody>
  </table>

  <footer>generated ${esc(new Date().toISOString())}</footer>
</body>
</html>
`;
}
