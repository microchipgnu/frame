// `frame init-mcp` — write a .mcp.json next to a frame so any MCP client
// (Claude Code, OpenCode, etc.) can curate it with zero further config.
//
// Run from inside a frame directory:
//   frame init-mcp                  → writes ./.mcp.json
//   frame init-mcp --name custom    → custom server name (default: frame-<schema.name>)
//   frame init-mcp --force          → overwrite existing .mcp.json

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Frame } from "../frame.js";
import { FrameError } from "../types.js";
import { resolveFrameDir } from "./util.js";

export function initMcp(args: string[]): void {
  const dir = resolveFrameDir(undefined); // always cwd
  const force = args.includes("--force");

  let name: string | undefined;
  const nameIdx = args.indexOf("--name");
  if (nameIdx >= 0) {
    name = args[nameIdx + 1];
    if (!name) {
      throw new FrameError(
        "BadArgs",
        "usage: frame init-mcp [--name <server-name>] [--force]",
      );
    }
  }

  // Default server name from the frame's schema.yml.
  if (!name) {
    const frame = new Frame(dir);
    name = `frame-${frame.schema().name}`;
  }

  const target = join(dir, ".mcp.json");
  if (existsSync(target) && !force) {
    throw new FrameError(
      "FileExists",
      `${target} already exists. Use --force to overwrite.`,
    );
  }

  const config = {
    mcpServers: {
      [name]: {
        command: "npx",
        args: ["-y", "@frames-ag/frame", "serve"],
        env: { FRAME_AGENT: "claude:opus-4.7" },
      },
    },
  };

  writeFileSync(target, JSON.stringify(config, null, 2) + "\n");
  console.log(`◇ wrote ${target}`);
  console.log(`  server name: ${name}`);
  console.log(`  command:     npx -y @frames-ag/frame serve`);
  console.log();
  console.log(`Start an MCP client (Claude Code, OpenCode, …) from this directory.`);
  console.log(`The server runs against ${dir} via cwd-default.`);
}
