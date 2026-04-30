// `frame project [<path>]` — regenerate .frame/dataset.db and .frame/rows.ndjson.

import { Frame } from "../frame.js";
import { resolveFrameDir, splitPathAndFlags } from "./util.js";

export function project(args: string[]): void {
  const { path } = splitPathAndFlags(args);
  const dir = resolveFrameDir(path);
  const frame = new Frame(dir, { agent: "system:cli" });
  const stats = frame.project();
  console.log(`◇ projected ${dir}`);
  console.log(`  entities:    ${stats.entity_count}`);
  console.log(`  facts:       ${stats.fact_count}`);
  console.log(`  deprecated:  ${stats.deprecated_count}`);
  console.log(`  invalid:     ${stats.invalid_row_count}`);
  console.log(`  duration:    ${stats.duration_ms}ms`);
}
