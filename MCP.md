# frame curation MCP v0.1.0

The MCP server is the engine. Every mutation to a frame goes through it. Agents (Claude Code, OpenCode, agent-os, native loops) call typed tools; the server enforces invariants and appends events to `events.ndjson`.

This document is the contract. An implementation that doesn't expose exactly these tools with these signatures and these enforced invariants is non-conformant.

## How a frame exposes itself

`frame serve <name>` starts an MCP server pointed at the frame directory. The server speaks MCP over stdio (default) or HTTP (`--transport http`). The agent harness configures the MCP server URL/command in its own way.

A single frame directory has exactly one MCP server instance at a time. The server holds a write lock at `.frame/lock` for the duration of any mutation; concurrent mutation attempts fail.

## The six tools

Mutation tools — these append events:

### `add_entity`

Create a new entity. Required before `set_fact` on it.

```typescript
input: {
  entity_id?: string  // optional; if omitted, a slug-shaped UUID is generated
}
output: {
  entity_id: string
}
```

Errors:
- `EntityExists` — the entity_id already exists
- `InvalidEntityId` — entity_id doesn't match `[a-z0-9][a-z0-9_-]*`

### `set_fact`

Set a field's value on an entity with required source. Last-write-wins by ts for `(entity_id, field)`.

```typescript
input: {
  entity_id: string,
  field: string,
  value: any,         // type checked against schema.yml
  source: Source,     // see PROTOCOL.md — url + retrieved_at required
  confidence?: number, // 0..1
  observed_at?: string // ISO 8601
}
output: {
  fact_id: string  // for later deprecation or evidence-attachment
}
```

Errors:
- `EntityNotFound`
- `UnknownField` — field not in schema.yml (unless schema.allow_unknown_fields is true)
- `TypeMismatch` — value type doesn't match field type
- `MissingSource` — source.url or source.retrieved_at absent
- `InvalidConfidence` — confidence not in [0, 1]

### `deprecate_fact`

Mark a previously-set fact as no longer trusted. Projection reverts to the most recent non-deprecated fact for that (entity, field), or unsets.

```typescript
input: {
  fact_id: string,
  reason: string  // required, human-readable
}
output: {
  ok: true
}
```

Errors:
- `FactNotFound`
- `AlreadyDeprecated`
- `MissingReason`

### `attach_evidence`

Add an additional source to an existing fact without changing the value.

```typescript
input: {
  fact_id: string,
  source: Source
}
output: {
  ok: true
}
```

Errors:
- `FactNotFound`
- `MissingSource`

Read-only tools — these never append events:

### `query`

Read the current state of the frame.

```typescript
input:
  | { mode: "entity", entity_id: string }
  | { mode: "all" }
  | { mode: "sql", sql: string }     // read-only SQL against the SQLite index
  | { mode: "field", field: string, value?: any }  // entities matching a field value
output: {
  rows: Row[]      // one row per matching entity
  total: number
}
```

Errors:
- `EntityNotFound` (mode=entity)
- `InvalidSQL` (mode=sql; rejected if it contains writes)

### `project`

Force regeneration of the SQLite index and `rows.ndjson` from `events.ndjson`. Idempotent. Called automatically after every mutation; can be invoked manually after external edits to events.ndjson (which should be rare).

```typescript
input: {}
output: {
  entity_count: number,
  fact_count: number,
  deprecated_count: number,
  invalid_row_count: number,
  duration_ms: number
}
```

## Resources (read-only)

| URI | content |
|---|---|
| `frame://schema` | the parsed `schema.yml` |
| `frame://readme` | the `README.md` content |
| `frame://changelog` | the `CHANGELOG.md` content |
| `frame://recent-events` | the last 100 lines of `events.ndjson`, parsed |
| `frame://rows` | the current rows projection (NDJSON) |
| `frame://stats` | counts (entities, facts, deprecated facts, runs) |

## Invariants the server enforces

These are why the MCP server exists. An agent harness can be replaced; the server holds the line:

1. **Schema validation at write time.** `set_fact` validates `value` against the field's type before appending. Invalid writes are rejected with `TypeMismatch`.
2. **Source required.** No `set_fact` without a source object containing at least `url` and `retrieved_at`.
3. **Entity existence.** `set_fact` and `attach_evidence` require the entity to exist.
4. **Atomicity.** Each tool call results in exactly one event appended (or zero, on error). No partial writes.
5. **Append-only.** The server never modifies or removes existing lines from `events.ndjson`.
6. **Lock discipline.** The server holds `.frame/lock` for the duration of every mutation. Concurrent calls serialize.
7. **Projection consistency.** After every mutation, the SQLite index is updated synchronously. `query` always reflects post-mutation state.
8. **Deprecate-not-delete.** No tool deletes events. `entity.removed` and `fact.deprecated` are the only "removal" semantics.

## Errors

All errors return:

```json
{
  "error": {
    "code": "FactNotFound",
    "message": "No fact with id ... exists",
    "details": { ... }   // optional, type-specific
  }
}
```

Error codes are stable strings. New codes can be added in minor versions; existing codes don't change meaning.

## What the server does NOT do

Deliberately excluded from the MCP surface (these belong in higher stages):

- **Scheduling, refresh, freshness.** No `tick`, no `schedule`. The server is a curation surface, not a runtime. The skateboard CLI's `tick` command spawns an agent harness pointed at this server; that's a different layer.
- **Tool calls to external providers.** No `search`, `fetch`, `extract`. Those are agent-side concerns; the agent uses its own tools, then writes results to the frame via `set_fact`.
- **Multi-frame composition.** No cross-frame queries. Future versions may add `frame://refs/<other-frame>/...` resources, but `query` is single-frame.
- **Authentication.** The server trusts whoever connects. AuthN/AuthZ is the responsibility of the transport layer (e.g., HTTP middleware) or the calling harness.
- **Streaming, real-time subscriptions.** Reads are point-in-time. Subscriptions can be added later as a minor-version extension.

## Versioning

Same semver discipline as PROTOCOL.md. The MCP server announces its version in its initialization handshake. Clients should refuse to operate against unknown major versions.
