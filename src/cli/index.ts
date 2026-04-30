#!/usr/bin/env bun
// frame CLI entry point.

import { init } from "./init.ts";
import { project } from "./project.ts";
import { query } from "./query.ts";
import { serve } from "./serve.ts";
import { doctor } from "./doctor.ts";
import { PROTOCOL_VERSION } from "../types.ts";

const [, , cmd, ...rest] = process.argv;

const COMMANDS: Record<string, (args: string[]) => void | Promise<void>> = {
  init,
  project,
  query,
  serve,
  doctor,
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
  frame serve <name>                      start the curation MCP server (stdio)
  frame project <name>                    regenerate .frame/dataset.db
  frame query <name> --all                dump every row
  frame query <name> --entity <id>        one row by id
  frame query <name> --field <f>=<v>      rows where field equals value
  frame query <name> --sql "<select…>"    read-only SQL against the index
  frame doctor [<name>]                   health check

documents:
  PROTOCOL.md   the file format spec
  MCP.md        the curation surface
  PLAN.md       staged scope

protocol ${PROTOCOL_VERSION}`);
}

main();
