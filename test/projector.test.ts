// Test the projector — the core deterministic algorithm.
// Same events.ndjson must always produce the same projection.

import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Frame } from "../src/frame.ts";
import { PROTOCOL_VERSION } from "../src/types.ts";

const TMP_BASE = "/tmp/frame-test";

function fresh(name: string): string {
  const dir = join(TMP_BASE, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, ".frame"), { recursive: true });
  writeFileSync(
    join(dir, "schema.yml"),
    `frame_protocol: "${PROTOCOL_VERSION}"
name: ${name.replace(/[^a-z0-9_-]/g, "-")}
fields:
  name:
    type: string
    required: true
  founded_year:
    type: int
  hq_country:
    type: string
`,
  );
  writeFileSync(join(dir, "events.ndjson"), "");
  return dir;
}

const SOURCE = {
  url: "https://example.com/article",
  retrieved_at: "2026-04-30T12:00:00Z",
  excerpt: "evidence text",
};

describe("projector", () => {
  test("empty frame has no rows", () => {
    const dir = fresh("empty");
    const frame = new Frame(dir);
    const stats = frame.project();
    expect(stats.entity_count).toBe(0);
    expect(frame.query({ mode: "all" }).rows).toEqual([]);
  });

  test("add_entity + set_fact produces one row", () => {
    const dir = fresh("one");
    const frame = new Frame(dir);
    frame.addEntity({ entity_id: "acme" });
    frame.setFact({
      entity_id: "acme",
      field: "name",
      value: "Acme",
      source: SOURCE,
    });
    const r = frame.query({ mode: "all" });
    expect(r.total).toBe(1);
    expect(r.rows[0]?.entity_id).toBe("acme");
    expect(r.rows[0]?.fields.name).toBe("Acme");
  });

  test("set_fact twice on same field — last wins", () => {
    const dir = fresh("supersession");
    const frame = new Frame(dir);
    frame.addEntity({ entity_id: "acme" });
    frame.setFact({
      entity_id: "acme",
      field: "name",
      value: "Acme",
      source: SOURCE,
    });
    frame.setFact({
      entity_id: "acme",
      field: "name",
      value: "Acme Inc",
      source: SOURCE,
    });
    const r = frame.query({ mode: "entity", entity_id: "acme" });
    expect(r.rows[0]?.fields.name).toBe("Acme Inc");
  });

  test("deprecate_fact reverts to prior fact", () => {
    const dir = fresh("revert");
    const frame = new Frame(dir);
    frame.addEntity({ entity_id: "acme" });
    frame.setFact({
      entity_id: "acme",
      field: "name",
      value: "Acme",
      source: SOURCE,
    });
    const second = frame.setFact({
      entity_id: "acme",
      field: "name",
      value: "WrongName",
      source: SOURCE,
    });
    expect(frame.query({ mode: "entity", entity_id: "acme" }).rows[0]?.fields.name).toBe(
      "WrongName",
    );

    frame.deprecateFact({ fact_id: second.fact_id, reason: "wrong source" });

    expect(frame.query({ mode: "entity", entity_id: "acme" }).rows[0]?.fields.name).toBe(
      "Acme",
    );
  });

  test("deprecate the only fact unsets the field", () => {
    const dir = fresh("unset");
    const frame = new Frame(dir);
    frame.addEntity({ entity_id: "acme" });
    const fact = frame.setFact({
      entity_id: "acme",
      field: "founded_year",
      value: 2024,
      source: SOURCE,
    });
    frame.deprecateFact({ fact_id: fact.fact_id, reason: "retracted" });
    const r = frame.query({ mode: "entity", entity_id: "acme" });
    expect(r.rows[0]?.fields.founded_year).toBeUndefined();
  });

  test("entity.removed drops the row", () => {
    const dir = fresh("removed");
    const frame = new Frame(dir);
    frame.addEntity({ entity_id: "acme" });
    frame.setFact({
      entity_id: "acme",
      field: "name",
      value: "Acme",
      source: SOURCE,
    });
    expect(frame.query({ mode: "all" }).total).toBe(1);
    frame.removeEntity({ entity_id: "acme", reason: "out of scope" });
    expect(frame.query({ mode: "all" }).total).toBe(0);
  });

  test("source validation rejects bare strings", () => {
    const dir = fresh("badsource");
    const frame = new Frame(dir);
    frame.addEntity({ entity_id: "acme" });
    expect(() =>
      frame.setFact({
        entity_id: "acme",
        field: "name",
        value: "Acme",
        source: "https://example.com" as any,
      }),
    ).toThrow(/source must be an object/);
  });

  test("set_fact rejects unknown field", () => {
    const dir = fresh("unknownfield");
    const frame = new Frame(dir);
    frame.addEntity({ entity_id: "acme" });
    expect(() =>
      frame.setFact({
        entity_id: "acme",
        field: "blob_count", // not in schema
        value: 5,
        source: SOURCE,
      }),
    ).toThrow(/UnknownField|not in schema/);
  });

  test("set_fact validates value type", () => {
    const dir = fresh("typecheck");
    const frame = new Frame(dir);
    frame.addEntity({ entity_id: "acme" });
    expect(() =>
      frame.setFact({
        entity_id: "acme",
        field: "founded_year",
        value: "not a number",
        source: SOURCE,
      }),
    ).toThrow(/expects int/);
  });

  test("set_fact requires entity to exist", () => {
    const dir = fresh("noent");
    const frame = new Frame(dir);
    expect(() =>
      frame.setFact({
        entity_id: "ghost",
        field: "name",
        value: "Ghost",
        source: SOURCE,
      }),
    ).toThrow(/EntityNotFound|doesn't exist/);
  });

  test("attach_evidence does not change the value", () => {
    const dir = fresh("attach");
    const frame = new Frame(dir);
    frame.addEntity({ entity_id: "acme" });
    const f = frame.setFact({
      entity_id: "acme",
      field: "name",
      value: "Acme",
      source: SOURCE,
    });
    frame.attachEvidence({
      fact_id: f.fact_id,
      source: { url: "https://other.example", retrieved_at: "2026-04-30T13:00:00Z" },
    });
    expect(frame.query({ mode: "entity", entity_id: "acme" }).rows[0]?.fields.name).toBe(
      "Acme",
    );
  });

  test("add_entity_with_facts produces one row in one call", () => {
    const dir = fresh("bulk");
    const frame = new Frame(dir);
    const r = frame.addEntityWithFacts({
      entity_id: "acme",
      source: SOURCE,
      facts: [
        { field: "name", value: "Acme" },
        { field: "founded_year", value: 2024 },
      ],
    });
    expect(r.entity_id).toBe("acme");
    expect(r.fact_ids.length).toBe(2);
    const row = frame.query({ mode: "entity", entity_id: "acme" }).rows[0];
    expect(row?.fields.name).toBe("Acme");
    expect(row?.fields.founded_year).toBe(2024);
  });

  test("set_facts is atomic — invalid fact rejects the whole call", () => {
    const dir = fresh("atomic");
    const frame = new Frame(dir);
    frame.addEntity({ entity_id: "acme" });
    expect(() =>
      frame.setFacts({
        entity_id: "acme",
        source: SOURCE,
        facts: [
          { field: "name", value: "Acme" },
          { field: "founded_year", value: "not-a-number" }, // bad — int expected
        ],
      }),
    ).toThrow(/expects int/);
    // First fact must NOT have landed.
    const row = frame.query({ mode: "all" }).rows[0];
    expect(row?.fields.name).toBeUndefined();
  });

  test("query include_sources annotates each field with its primary source", () => {
    const dir = fresh("withsrc");
    const frame = new Frame(dir);
    frame.addEntityWithFacts({
      entity_id: "acme",
      source: { ...SOURCE, excerpt: "Acme founded 2024" },
      facts: [
        { field: "name", value: "Acme" },
        { field: "founded_year", value: 2024 },
      ],
    });
    const r = frame.query({ mode: "all", include_sources: true });
    const row = r.rows[0]!;
    expect(row.sources).toBeDefined();
    expect(row.sources?.name?.url).toBe(SOURCE.url);
    expect(row.sources?.name?.excerpt).toBe("Acme founded 2024");
    expect(row.sources?.founded_year?.url).toBe(SOURCE.url);
  });

  test("all_sources view returns primary + corroborating evidence in one query", () => {
    const dir = fresh("allsrc");
    const frame = new Frame(dir);
    frame.addEntity({ entity_id: "acme" });
    const f = frame.setFact({
      entity_id: "acme",
      field: "name",
      value: "Acme",
      source: { url: "https://primary.example", retrieved_at: SOURCE.retrieved_at },
    });
    frame.attachEvidence({
      fact_id: f.fact_id,
      source: { url: "https://corroborating.example", retrieved_at: SOURCE.retrieved_at },
    });
    const r = frame.query({
      mode: "sql",
      sql: "SELECT source_url, is_primary FROM all_sources WHERE entity_id = 'acme' AND field = 'name' ORDER BY is_primary DESC",
    });
    expect(r.rows.length).toBe(2);
    expect((r.rows[0] as any).source_url).toBe("https://primary.example");
    expect((r.rows[0] as any).is_primary).toBe(1);
    expect((r.rows[1] as any).source_url).toBe("https://corroborating.example");
    expect((r.rows[1] as any).is_primary).toBe(0);
  });

  test("invalid rows are flagged, not dropped", () => {
    const dir = fresh("invalid");
    const frame = new Frame(dir);
    frame.addEntity({ entity_id: "acme" });
    // 'name' is required but never set — projection should mark this row invalid
    const r = frame.query({ mode: "all" });
    expect(r.total).toBe(1);
    expect(r.rows[0]?.invalid).toBeDefined();
    expect(r.rows[0]?.invalid?.[0]?.reason).toMatch(/required/);
  });

  // Regression: an externally-edited events.ndjson with a fact.set whose
  // entity was never created used to crash in SQLite with an opaque
  // SQLITE_CONSTRAINT_FOREIGNKEY. fold() now catches it first with a useful
  // line + event id pointer so the failure is debuggable.
  test("fold rejects fact.set referencing a missing entity, with line info", () => {
    const dir = fresh("orphan-fact");
    const frame = new Frame(dir);
    frame.addEntity({ entity_id: "real" });
    // Hand-craft a fact.set against an entity that doesn't exist.
    const orphan = {
      id: "00000000-0000-0000-0000-000000000001",
      ts: "2026-05-02T06:44:00Z",
      type: "fact.set",
      agent: "test:cli",
      payload: {
        fact_id: "00000000-0000-0000-0000-000000000002",
        entity_id: "ghost",
        field: "name",
        value: "Ghost",
        source: { ...SOURCE },
      },
    };
    appendFileSync(join(dir, "events.ndjson"), JSON.stringify(orphan) + "\n");
    expect(() => frame.project()).toThrow(/references unknown entity_id=ghost/);
    try {
      frame.project();
    } catch (e: any) {
      expect(e.message).toContain("events.ndjson:2");
      expect(e.message).toContain("ghost");
      expect(e.message).toContain(orphan.id);
      expect(e.code).toBe("OrphanEvent");
    }
  });

  test("fold rejects fact.deprecated against unknown fact", () => {
    const dir = fresh("orphan-dep");
    const frame = new Frame(dir);
    frame.addEntity({ entity_id: "acme" });
    const orphan = {
      id: "00000000-0000-0000-0000-000000000010",
      ts: "2026-05-02T06:44:00Z",
      type: "fact.deprecated",
      agent: "test:cli",
      payload: { fact_id: "no-such-fact", reason: "stale" },
    };
    appendFileSync(join(dir, "events.ndjson"), JSON.stringify(orphan) + "\n");
    expect(() => frame.project()).toThrow(/references unknown fact_id=no-such-fact/);
  });

  test("fold rejects evidence.attached against unknown fact", () => {
    const dir = fresh("orphan-ev");
    const frame = new Frame(dir);
    frame.addEntity({ entity_id: "acme" });
    const orphan = {
      id: "00000000-0000-0000-0000-000000000020",
      ts: "2026-05-02T06:44:00Z",
      type: "evidence.attached",
      agent: "test:cli",
      payload: { fact_id: "no-such-fact", source: { ...SOURCE } },
    };
    appendFileSync(join(dir, "events.ndjson"), JSON.stringify(orphan) + "\n");
    expect(() => frame.project()).toThrow(/references unknown fact_id=no-such-fact/);
  });

  // Regression: when projection fails, the prior dataset.db must remain intact
  // — workflows that gate "commit events.ndjson" on a successful project would
  // otherwise lose work silently.
  test("failed projection leaves prior dataset.db untouched", () => {
    const dir = fresh("atomic-rebuild");
    const frame = new Frame(dir);
    frame.addEntityWithFacts({
      entity_id: "acme",
      source: SOURCE,
      facts: [{ field: "name", value: "Acme" }],
    });
    const dbPath = join(dir, ".frame", "dataset.db");
    const goodSize = statSync(dbPath).size;
    const goodMtime = statSync(dbPath).mtimeMs;
    expect(goodSize).toBeGreaterThan(0);

    // Append an orphan event — next project() will throw mid-fold.
    const orphan = {
      id: "00000000-0000-0000-0000-0000000000aa",
      ts: "2026-05-02T06:45:00Z",
      type: "fact.set",
      agent: "test:cli",
      payload: {
        fact_id: "00000000-0000-0000-0000-0000000000bb",
        entity_id: "ghost",
        field: "name",
        value: "Ghost",
        source: { ...SOURCE },
      },
    };
    appendFileSync(join(dir, "events.ndjson"), JSON.stringify(orphan) + "\n");

    expect(() => frame.project()).toThrow(/references unknown entity_id=ghost/);

    // dataset.db must still be the old one; tmp must be cleaned up.
    expect(existsSync(dbPath)).toBe(true);
    expect(statSync(dbPath).size).toBe(goodSize);
    expect(statSync(dbPath).mtimeMs).toBe(goodMtime);
    expect(existsSync(dbPath + ".tmp")).toBe(false);
    expect(existsSync(join(dir, ".frame", "rows.ndjson.tmp"))).toBe(false);

    // And the old rows are still queryable.
    const r = frame.query({ mode: "entity", entity_id: "acme" });
    expect(r.rows[0]?.fields.name).toBe("Acme");
  });

  // Acquiring the lock with O_EXCL means a pre-existing lock file blocks a
  // second writer with FrameError("Locked"), instead of the previous
  // existsSync→writeFileSync TOCTOU window where two writers could both
  // think they won.
  test("acquireLock fails when another live process holds the lock", () => {
    const dir = fresh("lock-busy");
    // Plant a lock owned by a different live PID. PID 1 (launchd/init) is
    // always alive on Unix; process.kill(1, 0) raises EPERM (not ESRCH), and
    // the reclaim logic only treats ESRCH as "dead", so the lock stands.
    writeFileSync(
      join(dir, ".frame", "lock"),
      `someone:else pid=1 ts=${new Date().toISOString()}\n`,
    );
    const frame = new Frame(dir);
    expect(() => frame.addEntity({ entity_id: "acme" })).toThrow(/locked by someone:else/);
  });

  test("acquireLock reclaims a lock whose holder PID is dead", () => {
    const dir = fresh("lock-deadpid");
    // PIDs that high virtually never exist; process.kill(pid, 0) throws ESRCH.
    writeFileSync(
      join(dir, ".frame", "lock"),
      `crashed:cli pid=99999999 ts=${new Date().toISOString()}\n`,
    );
    const frame = new Frame(dir);
    // Should succeed by reclaiming the stale lock.
    const r = frame.addEntity({ entity_id: "acme" });
    expect(r.entity_id).toBe("acme");
    // Lock released after the operation.
    expect(existsSync(join(dir, ".frame", "lock"))).toBe(false);
  });

  test("acquireLock reclaims a lock older than the staleness window", () => {
    const dir = fresh("lock-ancient");
    // Live PID (PID 1) but ancient timestamp — staleness window kicks in.
    const ancient = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
    writeFileSync(
      join(dir, ".frame", "lock"),
      `forgotten:cli pid=1 ts=${ancient}\n`,
    );
    const frame = new Frame(dir);
    const r = frame.addEntity({ entity_id: "acme" });
    expect(r.entity_id).toBe("acme");
  });

  test("acquireLock reclaims a self-owned lock from a previous run", () => {
    const dir = fresh("lock-self");
    writeFileSync(
      join(dir, ".frame", "lock"),
      `prev:run pid=${process.pid} ts=${new Date().toISOString()}\n`,
    );
    const frame = new Frame(dir);
    expect(() => frame.addEntity({ entity_id: "acme" })).not.toThrow();
  });

  // Regression: addEntityWithFacts must be all-or-nothing. If fact validation
  // fails the entity must NOT have been appended (used to leak through
  // because addEntity ran under its own lock first).
  test("addEntityWithFacts: failed fact validation rolls back the whole call", () => {
    const dir = fresh("bundled-rollback");
    const frame = new Frame(dir);
    expect(() =>
      frame.addEntityWithFacts({
        entity_id: "acme",
        source: SOURCE,
        facts: [
          { field: "name", value: "Acme" },
          { field: "founded_year", value: "not-a-number" }, // bad
        ],
      }),
    ).toThrow(/expects int/);
    // Neither the entity nor any facts should appear in events.ndjson.
    const events = readFileSync(join(dir, "events.ndjson"), "utf8");
    expect(events).toBe("");
    expect(frame.query({ mode: "all" }).total).toBe(0);
  });

  test("project cleans up stale .tmp files left from a prior crash", () => {
    const dir = fresh("stale-tmp");
    const frame = new Frame(dir);
    // Drop bogus tmp files into .frame/ as if a previous run had crashed.
    const dbTmp = join(dir, ".frame", "dataset.db.tmp");
    const rowsTmp = join(dir, ".frame", "rows.ndjson.tmp");
    writeFileSync(dbTmp, "garbage");
    writeFileSync(rowsTmp, "garbage");

    frame.addEntityWithFacts({
      entity_id: "acme",
      source: SOURCE,
      facts: [{ field: "name", value: "Acme" }],
    });

    // After a successful project the tmp files should be gone (renamed away).
    expect(existsSync(dbTmp)).toBe(false);
    expect(existsSync(rowsTmp)).toBe(false);
    // And the live files should be valid (not the "garbage" we planted).
    expect(readFileSync(join(dir, ".frame", "rows.ndjson"), "utf8")).toContain("acme");
  });
});
