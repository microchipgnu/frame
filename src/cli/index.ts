#!/usr/bin/env node
// frame CLI entry point.

import { init } from "./init.js";
import { initMcp } from "./init-mcp.js";
import { project } from "./project.js";
import { query } from "./query.js";
import { render } from "./render.js";
import { serve } from "./serve.js";
import { doctor } from "./doctor.js";
import { verify } from "./verify.js";
import { PROTOCOL_VERSION } from "../types.js";

const [, , cmd, ...rest] = process.argv;

const COMMANDS: Record<string, (args: string[]) => void | Promise<void>> = {
  init,
  "init-mcp": initMcp,
  project,
  query,
  render,
  serve,
  doctor,
  verify,
};

async function main() {
  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    usage();
    return;
  }
  if (cmd === "--version" || cmd === "-V" || cmd === "version") {
    console.log(`frame protocol ${PROTOCOL_VERSION}`);
    return;
  }
  const handler = COMMANDS[cmd];
  if (!handler) {
    console.error(`unknown command: ${cmd}\n`);
    usage();
    process.exit(1);
  }
  try {
    await handler(rest);
  } catch (e: any) {
    if (e?.code) {
      console.error(`error [${e.code}]: ${e.message}`);
    } else {
      console.error(`error: ${e?.message ?? e}`);
    }
    process.exit(1);
  }
}

function usage() {
  console.log(`frame — open format for live, evidence-backed datasets

usage:
  frame init <name>                       scaffold a new frame
  frame init-mcp [--name X] [--force]     write .mcp.json next to a frame(s)
  frame render [<path>]                   write static index.html (single or multi-frame)
  frame serve [<path>]                    start the curation MCP server (stdio)
  frame project [<path>]                  regenerate .frame/dataset.db
  frame verify [<path>]                   re-fold events.ndjson; exit nonzero on issues
  frame query [<path>] --all              dump every row
  frame query [<path>] --entity <id>      one row by id
  frame query [<path>] --field <f>=<v>    rows where field equals value
  frame query [<path>] --sql "<select…>"  read-only SQL against the index
  frame query ... --with-sources          attach primary source per field
  frame doctor [<path>]                   health check

When the path argument is omitted, the current working directory is used.
This makes a project-scoped .mcp.json zero-config — drop it next to schema.yml.

documents:
  PROTOCOL.md   the file format spec
  MCP.md        the curation surface
  PLAN.md       staged scope

protocol ${PROTOCOL_VERSION}`);
}

main();
