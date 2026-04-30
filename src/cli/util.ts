// CLI helpers.

import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";

// Resolve a frame directory from a CLI argument. When the argument is omitted,
// default to the current working directory. This is what makes a project-scoped
// `.mcp.json` like `{"args":["@frames-ag/frame","serve"]}` Just Work — Claude
// Code spawns the MCP server with cwd at the .mcp.json's directory, so any
// frame whose .mcp.json sits next to its schema.yml is zero-config.
export function resolveFrameDir(arg: string | undefined): string {
  const dir = arg
    ? (isAbsolute(arg) ? arg : join(process.cwd(), arg))
    : process.cwd();
  if (!existsSync(join(dir, "schema.yml"))) {
    console.error(`error: no schema.yml at ${dir} — is this a frame?`);
    process.exit(1);
  }
  return dir;
}

// Split CLI args into a (positional) path and remaining flags. The path must
// be the first non-flag arg if any. Lets `frame query --all` Just Work without
// `--all` getting consumed as the frame directory.
export function splitPathAndFlags(args: string[]): {
  path: string | undefined;
  flags: string[];
} {
  const first = args[0];
  if (!first || first.startsWith("--")) return { path: undefined, flags: args };
  return { path: first, flags: args.slice(1) };
}
