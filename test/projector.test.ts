// Test the projector — the core deterministic algorithm.
// Same events.ndjson must always produce the same projection.

import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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
});
