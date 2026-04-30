# frame

The open format for live, evidence-backed datasets.

A **frame** is a directory containing a curated dataset, an event log of every change, and the schema that defines what belongs in it. Curators (humans or agents) mutate frames through a typed MCP curation server that enforces invariants at write time — no anonymous data, no silent overwrites, no deletions.

The format is portable: copy the directory, you have the dataset. The engine is plain: events.ndjson + git + a SQLite projection. The interface is agents-first: every harness that speaks MCP can curate.

## Documents

- **[PROTOCOL.md](./PROTOCOL.md)** — what bytes are on disk. The file format spec.
- **[MCP.md](./MCP.md)** — the curation surface. Nine tools, enforced invariants.
- **[PLAN.md](./PLAN.md)** — staged implementation plan + progress.

These are versioned semver and are the contract another implementer would honor. Everything else in this repo is one valid implementation, not the protocol.

## Install

```bash
npm install -g @frames-ag/frame      # or: bun add -g @frames-ag/frame
```

Runtime: Node 20+ or Bun 1.0+. Same package works on both.

## Quickstart

```bash
# create a frame
frame init my-dataset
cd my-dataset
# edit README.md and schema.yml

# generate a project-scoped MCP config (one command, no paths)
frame init-mcp

# any MCP client launched from this directory now sees a `frame-<name>` server
# with 9 curation tools — see MCP.md for the surface contract.
```

That's the entire setup. Drop into a frame directory, run `frame init-mcp`, point your agent harness (Claude Code, OpenCode, agent-os, …) at the project — done.

When you want to inspect the dataset directly:

```bash
frame query           # all rows (defaults to cwd)
frame query --entity acme-fi
frame query --field hq_country=DE
frame query --sql "SELECT * FROM all_sources WHERE entity_id = 'acme-fi'"
frame doctor          # health check
frame project         # regenerate the SQLite index after manual edits
```

All path arguments default to the current working directory.

## Use as an MCP server in any client

If you'd rather hand-write the config, here's what `frame init-mcp` produces:

```json
{
  "mcpServers": {
    "frame-my-dataset": {
      "command": "npx",
      "args": ["-y", "@frames-ag/frame", "serve"],
      "env": { "FRAME_AGENT": "claude:opus-4.7" }
    }
  }
}
```

The MCP server runs against whatever directory the client launches it in. Place this `.mcp.json` next to your frame's `schema.yml`.

## Status

Stage 0 (skateboard). One person, one frame, one machine. See [PLAN.md](./PLAN.md) for staged scope.
