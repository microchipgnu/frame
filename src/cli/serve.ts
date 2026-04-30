// `frame serve <name>` — start the curation MCP server over stdio.

import { startMcpServer } from "../mcp/server.js";
import { resolveFrameDir } from "./util.js";

export async function serve(args: string[]): Promise<void> {
  const dir = resolveFrameDir(args[0]);
  const agent = process.env.FRAME_AGENT ?? "system:cli";
  // No stdout chatter — MCP uses stdio. All logging goes to stderr.
  process.stderr.write(`◇ frame serve ${dir} (agent=${agent})\n`);
  await startMcpServer(dir, agent);
}
