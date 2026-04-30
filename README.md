# frame

The open format for live, evidence-backed datasets.

A **frame** is a directory containing a curated dataset, an event log of every change, and the schema that defines what belongs in it. Curators (humans or agents) mutate frames through a typed MCP curation server that enforces invariants at write time — no anonymous data, no silent overwrites, no deletions.

The format is portable: copy the directory, you have the dataset. The engine is plain: events.ndjson + git + a SQLite projection. The interface is agents-first: every harness that speaks MCP can curate.

## Documents

- **[PROTOCOL.md](./PROTOCOL.md)** — what bytes are on disk. The file format spec.
- **[MCP.md](./MCP.md)** — the curation surface. Six tools, enforced invariants.
- **[PLAN.md](./PLAN.md)** — staged implementation plan + progress.

These are versioned semver and are the contract another implementer would honor. Everything else in this repo is one valid implementation, not the protocol.

## Install

```bash
bun install
bun link
```

## Quickstart

```bash
# create a frame
frame init my-dataset

# edit my-dataset/README.md and my-dataset/schema.yml

# start the curation MCP server
frame serve my-dataset

# in another terminal: query the current state
frame query my-dataset --all
```

Point an MCP-speaking agent harness at the server (Claude Code with a skill, OpenCode with a config, agent-os with a binding) to begin curation.

## Status

Stage 0 (skateboard). One person, one frame, one machine. See [PLAN.md](./PLAN.md) for staged scope.
