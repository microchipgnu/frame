// The Frame engine class — the in-process API.
// The MCP server (src/mcp/server.ts) wraps this 1:1; the CLI uses it directly.
// All mutations go through these methods.

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "./db.js";
import {
  type AgentId,
  FrameError,
  type FrameEvent,
  type FrameSchema,
  type ProjectionStats,
  type Row,
  type Source,
} from "./types.js";
import { appendEvent, now, readEvents, uuid } from "./events.js";
import { loadSchema, validateValue } from "./schema.js";
import { validateSource } from "./source.js";
import { writeProjection } from "./projector.js";

export type FrameOptions = {
  agent?: AgentId; // who is doing the writing (defaults to "system:cli")
};

export class Frame {
  readonly dir: string;
  readonly schemaPath: string;
  readonly eventsPath: string;
  readonly lockPath: string;
  readonly dbPath: string;

  // mtime-based schema cache. Re-read when schema.yml changes on disk so the
  // running MCP server picks up edits without a restart.
  private _schema: FrameSchema | null = null;
  private _schemaMtime = 0;
  private agent: AgentId;

  constructor(dir: string, opts: FrameOptions = {}) {
    this.dir = dir;
    this.schemaPath = join(dir, "schema.yml");
    this.eventsPath = join(dir, "events.ndjson");
    this.lockPath = join(dir, ".frame", "lock");
    this.dbPath = join(dir, ".frame", "dataset.db");
    this.agent = opts.agent ?? "system:cli";
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  schema(): FrameSchema {
    const mtime = statSync(this.schemaPath).mtimeMs;
    if (!this._schema || mtime !== this._schemaMtime) {
      this._schema = loadSchema(this.schemaPath);
      this._schemaMtime = mtime;
    }
    return this._schema;
  }

  events(): FrameEvent[] {
    return readEvents(this.eventsPath);
  }

  // ── locking ────────────────────────────────────────────────────────────────

  private acquireLock(): () => void {
    mkdirSync(join(this.dir, ".frame"), { recursive: true });
    if (existsSync(this.lockPath)) {
      const holder = readFileSync(this.lockPath, "utf8").trim();
      throw new FrameError(
        "Locked",
        `frame is locked by ${holder} — remove ${this.lockPath} if stale`,
      );
    }
    writeFileSync(this.lockPath, `${this.agent} pid=${process.pid} ts=${now()}\n`);
    return () => {
      if (existsSync(this.lockPath)) rmSync(this.lockPath);
    };
  }

  // ── the six MCP operations ─────────────────────────────────────────────────

  // 1. add_entity
  addEntity(input: { entity_id?: string } = {}): { entity_id: string } {
    const release = this.acquireLock();
    try {
      const entity_id = input.entity_id ?? `e-${uuid().slice(0, 8)}`;
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(entity_id)) {
        throw new FrameError(
          "InvalidEntityId",
          `entity_id must match [a-z0-9][a-z0-9_-]*: ${JSON.stringify(entity_id)}`,
        );
      }
      const events = this.events();
      const exists = events.some(
        (e) =>
          e.type === "entity.created" &&
          (e.payload as any).entity_id === entity_id,
      );
      if (exists) {
        throw new FrameError("EntityExists", `entity ${entity_id} already exists`);
      }
      appendEvent(this.eventsPath, {
        id: uuid(),
        ts: now(),
        type: "entity.created",
        agent: this.agent,
        payload: { entity_id },
      } as FrameEvent);
      this.project();
      return { entity_id };
    } finally {
      release();
    }
  }

  // 2. set_fact
  setFact(input: {
    entity_id: string;
    field: string;
    value: unknown;
    source: Source;
    confidence?: number;
    observed_at?: string;
  }): { fact_id: string } {
    const release = this.acquireLock();
    try {
      const schema = this.schema();
      const def = schema.fields[input.field];
      if (!def && !schema.allow_unknown_fields) {
        throw new FrameError(
          "UnknownField",
          `field ${input.field} is not in schema.yml`,
        );
      }
      if (def) validateValue(input.field, def, input.value);
      const source = validateSource(input.source);
      if (input.confidence !== undefined) {
        if (
          typeof input.confidence !== "number" ||
          input.confidence < 0 ||
          input.confidence > 1
        ) {
          throw new FrameError(
            "InvalidConfidence",
            `confidence must be in [0, 1]`,
          );
        }
      }
      const events = this.events();
      const entityExists = events.some(
        (e) =>
          e.type === "entity.created" &&
          (e.payload as any).entity_id === input.entity_id,
      );
      if (!entityExists) {
        throw new FrameError(
          "EntityNotFound",
          `entity ${input.entity_id} doesn't exist; call add_entity first`,
        );
      }
      const fact_id = uuid();
      appendEvent(this.eventsPath, {
        id: uuid(),
        ts: now(),
        type: "fact.set",
        agent: this.agent,
        payload: {
          fact_id,
          entity_id: input.entity_id,
          field: input.field,
          value: input.value,
          source,
          ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
          ...(input.observed_at ? { observed_at: input.observed_at } : {}),
        },
      } as FrameEvent);
      this.project();
      return { fact_id };
    } finally {
      release();
    }
  }

  // 3. deprecate_fact
  deprecateFact(input: { fact_id: string; reason: string }): { ok: true } {
    const release = this.acquireLock();
    try {
      if (!input.reason) {
        throw new FrameError("MissingReason", "reason is required");
      }
      const events = this.events();
      const factEvt = events.find(
        (e) =>
          e.type === "fact.set" &&
          (e.payload as any).fact_id === input.fact_id,
      );
      if (!factEvt) {
        throw new FrameError("FactNotFound", `fact ${input.fact_id} not found`);
      }
      const alreadyDep = events.some(
        (e) =>
          e.type === "fact.deprecated" &&
          (e.payload as any).fact_id === input.fact_id,
      );
      if (alreadyDep) {
        throw new FrameError("AlreadyDeprecated", `fact ${input.fact_id} already deprecated`);
      }
      appendEvent(this.eventsPath, {
        id: uuid(),
        ts: now(),
        type: "fact.deprecated",
        agent: this.agent,
        payload: { fact_id: input.fact_id, reason: input.reason },
      } as FrameEvent);
      this.project();
      return { ok: true };
    } finally {
      release();
    }
  }

  // 4. attach_evidence
  attachEvidence(input: { fact_id: string; source: Source }): { ok: true } {
    const release = this.acquireLock();
    try {
      const source = validateSource(input.source);
      const events = this.events();
      const exists = events.some(
        (e) =>
          e.type === "fact.set" &&
          (e.payload as any).fact_id === input.fact_id,
      );
      if (!exists) {
        throw new FrameError("FactNotFound", `fact ${input.fact_id} not found`);
      }
      appendEvent(this.eventsPath, {
        id: uuid(),
        ts: now(),
        type: "evidence.attached",
        agent: this.agent,
        payload: { fact_id: input.fact_id, source },
      } as FrameEvent);
      this.project();
      return { ok: true };
    } finally {
      release();
    }
  }

  // entity.removed (helper, exposed on the Frame engine; in MCP this rides
  // under a thin tool name like `remove_entity` if we add one). Keeping it
  // available now since the protocol defines the event type.
  removeEntity(input: { entity_id: string; reason: string }): { ok: true } {
    const release = this.acquireLock();
    try {
      if (!input.reason) {
        throw new FrameError("MissingReason", "reason is required");
      }
      const events = this.events();
      const exists = events.some(
        (e) =>
          e.type === "entity.created" &&
          (e.payload as any).entity_id === input.entity_id,
      );
      if (!exists) {
        throw new FrameError(
          "EntityNotFound",
          `entity ${input.entity_id} not found`,
        );
      }
      appendEvent(this.eventsPath, {
        id: uuid(),
        ts: now(),
        type: "entity.removed",
        agent: this.agent,
        payload: { entity_id: input.entity_id, reason: input.reason },
      } as FrameEvent);
      this.project();
      return { ok: true };
    } finally {
      release();
    }
  }

  // 5. query
  query(
    input:
      | { mode: "entity"; entity_id: string }
      | { mode: "all" }
      | { mode: "field"; field: string; value?: unknown }
      | { mode: "sql"; sql: string },
  ): { rows: Row[]; total: number } {
    if (!existsSync(this.dbPath)) this.project();

    const db = new Database(this.dbPath, { readonly: true });
    type DbRow = { entity_id: string; fields_json: string; invalid_json: string | null };
    try {
      switch (input.mode) {
        case "entity": {
          const stmt = db.prepare(
            "SELECT entity_id, fields_json, invalid_json FROM rows WHERE entity_id = ?",
          );
          const r = stmt.get<DbRow>(input.entity_id);
          if (!r) {
            throw new FrameError("EntityNotFound", `entity ${input.entity_id} not in current rows`);
          }
          return { rows: [rowFromDb(r)], total: 1 };
        }
        case "all": {
          const stmt = db.prepare(
            "SELECT entity_id, fields_json, invalid_json FROM rows ORDER BY entity_id",
          );
          const rs = stmt.all<DbRow>();
          return { rows: rs.map(rowFromDb), total: rs.length };
        }
        case "field": {
          const stmt = db.prepare(
            "SELECT entity_id, fields_json, invalid_json FROM rows ORDER BY entity_id",
          );
          const rs = stmt.all<DbRow>().map(rowFromDb);
          const filtered = rs.filter((r) => {
            if (input.value === undefined) return r.fields[input.field] !== undefined;
            return r.fields[input.field] === input.value;
          });
          return { rows: filtered, total: filtered.length };
        }
        case "sql": {
          if (/\b(insert|update|delete|drop|alter|create|attach)\b/i.test(input.sql)) {
            throw new FrameError("InvalidSQL", "sql must be read-only");
          }
          const stmt = db.prepare(input.sql);
          const rs = stmt.all() as Row[];
          // SQL mode returns raw rows — caller gets exactly what they asked for.
          return { rows: rs as Row[], total: rs.length };
        }
      }
    } finally {
      db.close();
    }
  }

  // 6. project — regenerate derived state.
  project(): ProjectionStats {
    return writeProjection(this.dir, this.events(), this.schema());
  }
}

function rowFromDb(r: {
  entity_id: string;
  fields_json: string;
  invalid_json: string | null;
}): Row {
  const out: Row = {
    entity_id: r.entity_id,
    fields: JSON.parse(r.fields_json),
  };
  if (r.invalid_json) out.invalid = JSON.parse(r.invalid_json);
  return out;
}
