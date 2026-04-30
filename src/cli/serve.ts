// `frame serve <name>` — start the curation MCP server over stdio.

import { startMcpServer } from "../mcp/server.js";
import { resolveFrameDir, splitPathAndFlags } from "./util.js";

export async function serve(args: string[]): Promise<void> {
  const { path } = splitPathAndFlags(args);
  const dir = resolveFrameDir(path);
  const agent = process.env.FRAME_AGENT ?? "system:cli";
  // No stdout chatter — MCP uses stdio. All logging goes to stderr.
  process.stderr.write(`◇ frame serve ${dir} (agent=${agent})\n`);
  await startMcpServer(dir, agent);
}
