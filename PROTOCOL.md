# frame protocol v0.2.0

**Changes since v0.1.0:** none in the on-disk format itself. The protocol's *file* shape is
unchanged. v0.2.0 marks additive growth in the curation MCP surface (bulk-write tools,
`include_sources` on `query`, an `all_sources` SQL view) — see [MCP.md](./MCP.md). v0.1.0
frames remain readable and writable by v0.2.0 implementations.

A frame is a directory containing a curated, evidence-backed, version-controlled dataset.

This document specifies what bytes must be on disk for a directory to be a valid frame. It does not specify how those bytes get there — that's the [MCP curation surface](./MCP.md).

## Directory layout

```
my-frame/
├── README.md              prose specification of the dataset's purpose
├── schema.yml             the contract: types, descriptions, optional tests
├── events.ndjson          append-only canonical event log (the source of truth)
├── CHANGELOG.md           narrative record of significant changes
├── .gitattributes         registers union-merge for events.ndjson
├── .git/                  version history
└── .frame/                derived artifacts (gitignored)
    ├── dataset.db         SQLite index regenerated from events
    ├── rows.ndjson        current-state projection regenerated from events
    └── lock               present while a tick is in progress
```

## Invariants

1. `events.ndjson` is the source of truth. If derived artifacts disagree, events wins.
2. `events.ndjson` is append-only. Lines are never modified or removed.
3. Every fact names a source. No anonymous data.
4. Updates happen via supersession (new event with same `entity_id` + `field`), never mutation.
5. Removal happens via deprecation, not deletion. `fact.deprecated` events are first-class.
6. Events are written in monotonic timestamp order (within a single writer).
7. The frame directory is a git repository.

A consumer that violates any of these is non-conformant.

## Event envelope

Every line in `events.ndjson` is a JSON object with five required fields:

```json
{
  "id": "uuid-v4",
  "ts": "2026-04-30T14:22:11.000Z",
  "type": "fact.set",
  "agent": "claude:opus-4.7",
  "payload": { "...": "type-specific" }
}
```

| field | type | description |
|---|---|---|
| `id` | UUID v4 | unique event ID |
| `ts` | ISO 8601 | when the event was recorded (UTC, millisecond precision) |
| `type` | string | event type (see below) |
| `agent` | string | who made this change. Format: `<kind>:<identifier>` (e.g. `claude:opus-4.7`, `human:luis@frames.ag`, `system:projector`) |
| `payload` | object | type-specific fields |

Unknown event types must be skipped by the projector (forward compatibility).

## Event types

### `entity.created`

```json
{ "payload": { "entity_id": "acme-fi" } }
```

Establishes that an entity exists. `entity_id` is a stable, slug-shaped string (`[a-z0-9][a-z0-9_-]*`). Required before any `fact.set` for that entity.

### `fact.set`

```json
{
  "payload": {
    "fact_id": "uuid-v4",
    "entity_id": "acme-fi",
    "field": "founded_year",
    "value": 2024,
    "source": { "url": "...", "retrieved_at": "...", "excerpt": "..." },
    "confidence": 0.92,
    "observed_at": "2026-04-29T00:00:00Z"
  }
}
```

Sets the value of a field on an entity. Last-write-wins by `ts` for `(entity_id, field)`. `fact_id` is a fresh UUID v4 used to reference this fact later. `confidence` (0–1) and `observed_at` are optional.

### `fact.deprecated`

```json
{ "payload": { "fact_id": "...", "reason": "Source retracted on 2026-04-25" } }
```

Marks a previously-set fact as no longer trusted. The projection treats the (entity_id, field) as if this fact never existed and reverts to the most recent non-deprecated `fact.set` for that pair, or unsets if none exists. `reason` is required.

### `evidence.attached`

```json
{ "payload": { "fact_id": "...", "source": { "url": "...", "retrieved_at": "..." } } }
```

Adds an additional source to an existing fact without changing the value. Used when a second source corroborates an existing claim.

### `entity.removed`

```json
{ "payload": { "entity_id": "acme-fi", "reason": "Disqualified — out of scope" } }
```

Removes an entity from the rows projection. Equivalent to deprecating all of its facts. `reason` is required. The entity's history remains in `events.ndjson` and can be inspected via `git log`.

## Source schema

A `source` is a JSON object:

```json
{
  "url": "https://techcrunch.com/...",
  "retrieved_at": "2026-04-29T15:30:00Z",
  "title": "Acme Financial raises Series A",
  "archive_url": "https://web.archive.org/...",
  "excerpt": "Acme, founded in 2024, raised a $12M Series A..."
}
```

| field | required | description |
|---|---|---|
| `url` | yes | the source URL |
| `retrieved_at` | yes | when the URL was fetched (ISO 8601) |
| `title` | no | human-readable title of the source |
| `archive_url` | no | Wayback or similar permanent archive |
| `excerpt` | no | verbatim text from the source supporting the claim. Strongly recommended for verifiability |

Bare strings are not valid sources. The minimum is `{ url, retrieved_at }`.

## schema.yml

```yaml
frame_protocol: "0.1.0"
name: ai_agent_wallets_eu
description: |
  AI agent wallet companies headquartered in Europe.
entity_type: company
fields:
  name:
    type: string
    required: true
  hq_country:
    type: string
    required: true
  founded_year:
    type: int
  category:
    type: enum
    values: [wallet, payment_infra, key_management, custody]
tests:
  - name: hq_must_be_eu
    field: hq_country
    rule: enum
    allowed: [DE, FR, UK, ES, IT, NL, SE, PL, PT, IE, AT, BE, DK, FI]
```

| field | description |
|---|---|
| `frame_protocol` | semver of the protocol the frame conforms to |
| `name` | matches the directory name |
| `description` | freeform; fed to agents as part of the contract |
| `entity_type` | what each row represents |
| `fields` | map of field name to `{type, required?, ...}`. Types: `string`, `int`, `float`, `bool`, `date`, `url`, `enum` |
| `tests` | list of named rules a value must satisfy. Implementations may extend the rule vocabulary |

## Projection

Given an `events.ndjson`, the canonical rows projection is computed by:

1. Read events in file order (already monotonic by `ts`).
2. Build a `Map<entity_id, Map<field, fact_id>>` mapping each (entity, field) to the most recent non-deprecated fact.
3. Drop entries whose `entity_id` has an `entity.removed` event after their last `fact.set`.
4. For each remaining entity, emit a row with all its current fields.
5. Validate each row against `schema.yml`. Rows failing validation are emitted with an `invalid: true` marker (not silently dropped — the projector's job is to materialize, not to filter).

The projection is deterministic: the same `events.ndjson` always produces identical rows. This means derived artifacts can be regenerated at any time and are not part of the canonical state.

## Versioning

The protocol uses semver. The `frame_protocol` field in `schema.yml` declares which version a frame conforms to.

- **Patch** changes (0.1.0 → 0.1.1): clarifications, bug fixes in the spec text. No on-disk format change.
- **Minor** changes (0.1.0 → 0.2.0): new optional event types, new optional schema fields. Older readers must skip unknowns.
- **Major** changes (0.x → 1.0): breaking format changes. Implementations refuse to operate on unknown major versions.

## Conformance

A conformant frame implementation:

1. Reads and writes the event envelope above.
2. Enforces every invariant when writing.
3. Implements the projection algorithm above (or a behaviorally equivalent one).
4. Validates `schema.yml` against the field vocabulary.
5. Initializes new frames with the directory layout above, including `.gitattributes` configured for `events.ndjson`.

A conformant *consumer* may skip writing — read-only tools (renderers, exporters) only need the projection algorithm.
