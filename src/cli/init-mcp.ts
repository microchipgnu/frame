// `frame init-mcp` — write a .mcp.json that exposes every frame in this
// directory tree as its own MCP server.
//
// Three modes, auto-detected:
//   1. cwd has schema.yml, no nested frames → single-server config (cwd-default).
//   2. cwd has schema.yml AND nested frames → multi-server config (root + nested).
//   3. cwd has no schema.yml but nested frames → multi-server config (nested only).
//
// A "frame" is a directory containing schema.yml — same convention as
// frames.dev's hosted resolver.
//
//   frame init-mcp                  → auto-detect, write ./.mcp.json
//   frame init-mcp --name custom    → only valid in single-frame mode
//   frame init-mcp --force          → overwrite existing .mcp.json

import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Frame } from "../frame.js";
import { FrameError } from "../types.js";

const SKIP_DIRS = new Set([".git", ".frame", "node_modules", "dist"]);

// Walk a directory tree, find every dir containing schema.yml.
// Returns absolute paths. Skips hidden dirs, .git/, .frame/, node_modules/, dist/.
function findFrames(rootDir: string, includeRoot: boolean): string[] {
  const out: string[] = [];
  function walk(dir: string, depth: number): void {
    if (depth > 6) return; // sanity cap
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
      let isDir = false;
      try {
        isDir = statSync(child).isDirectory();
      } catch {
        continue;
      }
      if (isDir) walk(child, depth + 1);
    }
  }
  walk(rootDir, 0);
  return out;
}

// Read a frame's schema.yml to get its declared name. Falls back to dir basename.
function frameName(dir: string): string {
  try {
    const f = new Frame(dir);
    return f.schema().name;
  } catch {
    return dir.split("/").pop() ?? "frame";
  }
}

export function initMcp(args: string[]): void {
  const cwd = process.cwd();
  const force = args.includes("--force");

  let nameOverride: string | undefined;
  const nameIdx = args.indexOf("--name");
  if (nameIdx >= 0) {
    nameOverride = args[nameIdx + 1];
    if (!nameOverride) {
      throw new FrameError(
        "BadArgs",
        "usage: frame init-mcp [--name <server-name>] [--force]",
      );
    }
  }

  const cwdIsFrame = existsSync(join(cwd, "schema.yml"));
  const nestedFrames = findFrames(cwd, false);

  // No frames anywhere — bail with a useful message.
  if (!cwdIsFrame && nestedFrames.length === 0) {
    throw new FrameError(
      "NoFramesFound",
      `No schema.yml here or in subdirectories. Run \`frame init\` first to scaffold a frame.`,
    );
  }

  const target = join(cwd, ".mcp.json");
  if (existsSync(target) && !force) {
    throw new FrameError(
      "FileExists",
      `${target} already exists. Use --force to overwrite.`,
    );
  }

  // Build the list of servers to register.
  type ServerEntry = { name: string; relPath: string | null };
  const servers: ServerEntry[] = [];

  if (cwdIsFrame) {
    const name = nameOverride ?? `frame-${frameName(cwd)}`;
    servers.push({ name, relPath: null }); // null relPath = cwd-default
  } else if (nameOverride) {
    throw new FrameError(
      "BadArgs",
      "--name only applies in single-frame mode (cwd is a frame). Multi-frame configs name servers from each schema.yml automatically.",
    );
  }

  for (const frameDir of nestedFrames) {
    const rel = relative(cwd, frameDir);
    servers.push({ name: `frame-${frameName(frameDir)}`, relPath: rel });
  }

  // Disambiguate any duplicate server names by suffixing with the rel path.
  const counts = new Map<string, number>();
  for (const s of servers) counts.set(s.name, (counts.get(s.name) ?? 0) + 1);
  const seen = new Map<string, number>();
  for (const s of servers) {
    if ((counts.get(s.name) ?? 0) > 1) {
      const suffix = s.relPath ? `-${s.relPath.replace(/[^a-z0-9]+/gi, "-")}` : "";
      s.name = `${s.name}${suffix}`;
    }
    const n = (seen.get(s.name) ?? 0) + 1;
    seen.set(s.name, n);
    if (n > 1) s.name = `${s.name}-${n}`;
  }

  // Compose the MCP config.
  const mcpServers: Record<string, unknown> = {};
  for (const s of servers) {
    const args = ["-y", "@frames-ag/frame", "serve"];
    if (s.relPath) args.push(s.relPath);
    mcpServers[s.name] = {
      command: "npx",
      args,
      env: { FRAME_AGENT: "claude:opus-4.7" },
    };
  }

  writeFileSync(target, JSON.stringify({ mcpServers }, null, 2) + "\n");

  // Reporting.
  console.log(`◇ wrote ${target}`);
  console.log(`  ${servers.length} ${servers.length === 1 ? "server" : "servers"}:`);
  for (const s of servers) {
    const path = s.relPath ? s.relPath : "(cwd)";
    console.log(`    ${s.name.padEnd(30)} → ${path}`);
  }
  console.log();
  console.log(`Start an MCP client (Claude Code, OpenCode, …) from this directory.`);
}
