// `frame verify [<path>]` — re-fold events.ndjson and report any issues
// (referential errors, schema-invalid rows) without writing the projection.
//
// Designed for CI: run between `frame tick` and `git commit` so a bad
// events.ndjson is caught loudly before any commit decision is made. Exits 0
// when projectable, non-zero (with a useful message) otherwise.

import { join } from "node:path";
import { Frame } from "../frame.js";
import { readEventsWithLines } from "../events.js";
import { fold, rowsFromState } from "../projector.js";
import { resolveFrameDir, splitPathAndFlags } from "./util.js";

export function verify(args: string[]): void {
  const { path } = splitPathAndFlags(args);
  const dir = resolveFrameDir(path);
  const frame = new Frame(dir);
  const schema = frame.schema();

  let events: ReturnType<typeof readEventsWithLines>;
  try {
    events = readEventsWithLines(join(dir, "events.ndjson"));
  } catch (e: any) {
    fail(dir, "events.ndjson failed to parse", e);
  }

  // fold() throws FrameError("OrphanEvent") with a line-located message on
  // any referential violation (fact.set against missing entity, etc.). Let
  // that propagate up to the top-level error formatter in cli/index.ts so the
  // exit code carries the failure.
  let state: ReturnType<typeof fold>;
  try {
    state = fold(events!);
  } catch (e: any) {
    fail(dir, "fold rejected events.ndjson", e);
  }

  const rows = rowsFromState(state!, schema);
  const invalid = rows.filter((r) => r.invalid && r.invalid.length > 0);

  console.log(`◇ verified ${dir}`);
  console.log(`  events:      ${events!.length}`);
  console.log(`  entities:    ${rows.length}`);
  console.log(`  facts:       ${state!.facts.size}`);
  console.log(`  deprecated:  ${state!.deprecated.size}`);
  console.log(`  invalid:     ${invalid.length}`);

  // Schema-invalid rows are surfaced as warnings, not failures: they're
  // tracked through `rows.invalid` and don't crash projection — they
  // represent curation gaps (missing required field, bad enum value), not
  // structural corruption. CI shouldn't refuse to commit otherwise-valid
  // agent work because a row is incomplete.
  if (invalid.length > 0) {
    console.warn("");
    console.warn(`warn: ${invalid.length} row(s) have schema validation issues:`);
    for (const r of invalid) {
      for (const i of r.invalid!) {
        console.warn(`  ${r.entity_id}: ${i.reason}`);
      }
    }
  }
}

function fail(dir: string, summary: string, e: unknown): never {
  const err = e as { code?: string; message?: string };
  console.error(`◇ verify failed ${dir}`);
  console.error(`  ${summary}`);
  if (err?.code) console.error(`  [${err.code}] ${err.message}`);
  else console.error(`  ${err?.message ?? String(e)}`);
  process.exit(1);
}
