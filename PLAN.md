# frame — skateboard plan

The minimum useful frame: one person, one frame, one machine, agents-first via MCP.

This file tracks what's done and what's next. PROTOCOL.md and MCP.md are the load-bearing specs everything else depends on.

---

## Stage 0 — skateboard

Goal: a single-machine, single-frame system where an agent (Claude Code or OpenCode via MCP) can curate a real dataset end-to-end. Replaces the `webset/` sketch with an MCP-first architecture.

### Frozen artifacts (must be right before code)

- [x] **PROTOCOL.md** — file format spec. Defines events.ndjson schema, schema.yml shape, source schema, projection semantics.
- [x] **MCP.md** — the curation MCP surface. Six tools (plus `remove_entity`), exact signatures, enforced invariants.

### Implementation

- [x] `package.json`, `tsconfig.json`, `.gitignore`
- [x] `src/types.ts` — Event, Source, Schema, Frame types
- [x] `src/events.ts` — read/write/append events.ndjson, UUID + monotonic ts
- [x] `src/source.ts` — source validation (url + retrieved_at required)
- [x] `src/schema.ts` — schema.yml parsing + per-field type validation
- [x] `src/projector.ts` — events → SQLite + current rows projection
- [x] `src/frame.ts` — the Frame class (in-process engine API)
- [x] `src/mcp/server.ts` — MCP server bootstrap (stdio transport, all tools + resources)
- [x] `src/cli/index.ts` — CLI entry with help / version dispatch
- [x] `src/cli/init.ts` — `frame init <name-or-path>` scaffolds README, schema.yml, events.ndjson, CHANGELOG, .gitattributes, git init
- [x] `src/cli/serve.ts` — `frame serve <name>` starts the MCP server over stdio
- [x] `src/cli/project.ts` — `frame project <name>` regenerates derived index
- [x] `src/cli/query.ts` — `frame query <name> [--all|--entity|--field|--sql]`
- [x] `src/cli/doctor.ts` — `frame doctor [<name>]`
- [x] `.gitattributes` installed by `frame init` (events.ndjson uses `merge=union`)
- [ ] custom 3-way merge driver for `rows.ndjson`-equivalent (deferred — `merge=union` on events.ndjson is sufficient for skateboard since rows.ndjson is derived/gitignored)
- [x] `test/projector.test.ts` — 12 passing tests covering all six tools + projection invariants

### Integration

- [x] one real example frame in `examples/ai-agent-wallets-eu/` (scaffolded; not yet curated)
- [ ] one agent harness wired up: Claude Code skill or OpenCode config that points at `frame serve`

### Graduation test

- [ ] Run a real curation session against `examples/ai-agent-wallets-eu/` — at least 20 entities with evidence, across multiple sessions, with at least one deprecation event — and confirm the frame is obviously useful.

### Status as of 2026-04-30

**Engine works end-to-end. First external curation session completed (see FEEDBACK.md).**

Verified via:
- `bun test` — 16/16 projector tests pass (12 original + 4 for v0.2.0 additions).
- Manual smoke on both runtimes: Bun and Node. Same code, same behavior.
- MCP handshake + `tools/list` returns 9 tools with proper JSON Schema.
- `doctor` passes on a freshly-initialized + curated frame.
- Real curation session via Claude Code MCP against `examples/ai-agent-wallets-eu/`:
  3 entities curated with full evidence, x402-paid Exa search drove the agent,
  every fact carries a verbatim excerpt.

**v0.2.0 ships in response to feedback (see FEEDBACK.md):**
- Cross-runtime: ships as Node + Bun (single npm package).
- Bulk write: `set_facts`, `add_entity_with_facts` — ~5–10× session throughput.
- `query include_sources` — evidence visible by default in queries that opt in.
- `all_sources` SQL view — primary + corroborating evidence in one place.
- Schema hot-reload — edit `schema.yml`, MCP picks it up, no restart.

**Discipline note (anti-revisit):** the engine knows about field *types* (`string`, `int`, `enum`), not field *values* ("which countries are European"). Domain content lives in each frame's `schema.yml`, never in the engine source. Tempting feedback like "bake the EU country list into the engine" gets answered at the dataset layer, not the runtime layer.

**Next concrete step:** publish to npm as `@frames-ag/frame`, then write a thin Claude Code skill that bakes the curation discipline (always cite a source, prefer verbatim excerpts, never invent values) into a reusable system prompt agents can adopt.

---

## Stage 1 — bicycle (deferred)

Multi-frame, scheduled local. Heartbeat. Multi-harness support. NOT in skateboard scope.

## Stage 2 — motorcycle (deferred)

Frames Cloud. `frame deploy`. Web inspector. Stripe billing.

## Stage 3 — car (deferred)

Federated catalog as marketplace. Cross-frame composition. Enterprise tier.

---

## Discipline

1. PROTOCOL.md and MCP.md are versioned semver. Once frozen, breaking changes cost a major version.
2. Every mutation to a frame goes through the MCP server. No direct file edits — even from the CLI; the CLI talks to the same engine the MCP server exposes.
3. Every fact names a source. The MCP server rejects writes that don't.
4. Deprecate, don't delete. `fact.deprecated` events; rows projection ignores deprecated facts.
5. The protocol layer never grows to absorb runtime concerns (heartbeat, scheduling, lifecycle states, wallet, tool catalog access). Those live in separate stages.

## Architectural decisions (anti-revisit list)

These have been considered and decided. Don't re-open without new evidence.

- **Wallets and tool catalog access are runtime configuration, not part of the frame protocol or the curation MCP.** Self-hosted users configure their own wallet/tools in the agent harness. Frames Cloud injects managed wallet/tools into the runtime on the user's behalf. The frame MCP server stays identical across modes. *Decided 2026-04-30. See MCP.md § "What the server does NOT do".*
- **Catalog-mediated tools are not in scope for skateboard.** Agents use their harness's native tools (Claude Code's WebSearch/WebFetch, OpenCode's bash+curl, etc.) and write results to the frame via `set_fact`. The frame records what the runtime claims; source verification (was this URL actually fetched?) is a runtime concern, not the protocol's. *Decided 2026-04-30.*
- **The CLI is a thin client of the same engine the MCP server uses.** No bypass, no direct file edits. Both surfaces enforce identical invariants. *Decided 2026-04-30.*
