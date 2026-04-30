// `frame project <name>` — regenerate .frame/dataset.db and .frame/rows.ndjson.

import { Frame } from "../frame.ts";
import { resolveFrameDir } from "./util.ts";

export function project(args: string[]): void {
  const dir = resolveFrameDir(args[0]);
  const frame = new Frame(dir, { agent: "system:cli" });
  const stats = frame.project();
  console.log(`◇ projected ${dir}`);
  console.log(`  entities:    ${stats.entity_count}`);
  console.log(`  facts:       ${stats.fact_count}`);
  console.log(`  deprecated:  ${stats.deprecated_count}`);
  console.log(`  invalid:     ${stats.invalid_row_count}`);
  console.log(`  duration:    ${stats.duration_ms}ms`);
}
