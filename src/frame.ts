// The Frame engine class — the in-process API.
// The MCP server (src/mcp/server.ts) wraps this 1:1; the CLI uses it directly.
// All mutations go through these methods.

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
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
import { appendEvent, now, readEvents, readEventsWithLines, uuid } from "./events.js";
import { loadSchema, validateValue } from "./schema.js";
import { validateSource } from "./source.js";
import { writeProjection } from "./projector.js";

export type FrameOptions = {
  agent?: AgentId; // who is doing the writing (defaults to "system:cli")
};

// Locks older than this are treated as stale and reclaimed. 10 minutes is well
// beyond any normal frame mutation (single-digit seconds for the largest
// projections we've seen) but short enough that a forgotten lock from a
// crashed CI runner doesn't wedge the next scheduled tick indefinitely.
const LOCK_STALE_MS = 10 * 60 * 1000;

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

  // Acquire the per-frame writer lock. Single-host advisory only — guards
  // against two CLI/MCP processes on the same machine racing on the same
  // events.ndjson + projection. Not a substitute for distributed locking.
  //
  // Implementation:
  //   - Atomic create with O_EXCL ('wx'), so two callers can't both think they
  //     won (the existsSync→writeFileSync sequence had a TOCTOU window).
  //   - On collision, treat the lock as stale and reclaim it if the holder
  //     PID is dead, the holder is this same process (a previous run that
  //     didn't release), or the lock is older than LOCK_STALE_MS. Otherwise
  //     surface FrameError("Locked") with the holder string.
  private acquireLock(): () => void {
    mkdirSync(join(this.dir, ".frame"), { recursive: true });
    const payload = `${this.agent} pid=${process.pid} ts=${now()}\n`;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(this.lockPath, "wx");
        try {
          writeSync(fd, payload);
        } finally {
          closeSync(fd);
        }
        return () => {
          if (existsSync(this.lockPath)) rmSync(this.lockPath);
        };
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        if (attempt === 0 && this.tryReclaimStaleLock()) continue;
        const holder = (() => {
          try { return readFileSync(this.lockPath, "utf8").trim(); }
          catch { return "<unknown>"; }
        })();
        throw new FrameError(
          "Locked",
          `frame is locked by ${holder} — remove ${this.lockPath} if stale`,
        );
      }
    }
    // Unreachable: the loop either returns or throws on each iteration.
    throw new FrameError("Locked", "could not acquire lock");
  }

  private tryReclaimStaleLock(): boolean {
    let raw: string;
    try {
      raw = readFileSync(this.lockPath, "utf8");
    } catch {
      // File vanished between EEXIST and our read — treat as already cleared.
      return true;
    }
    const pidMatch = raw.match(/pid=(\d+)/);
    const tsMatch = raw.match(/ts=(\S+)/);

    let stale = false;
    if (pidMatch) {
      const pid = Number(pidMatch[1]);
      if (pid === process.pid) {
        // Same process re-acquiring — previous run didn't release (e.g.
        // killed mid-op). Reclaim rather than deadlock against ourselves.
        stale = true;
      } else {
        try {
          // Signal 0 probes existence without delivering anything.
          process.kill(pid, 0);
        } catch (err) {
          // ESRCH = no such process (truly dead → reclaim).
          // EPERM = exists but we lack permission (e.g. PID 1) → keep lock.
          if ((err as NodeJS.ErrnoException).code === "ESRCH") stale = true;
        }
      }
    }
    if (!stale && tsMatch) {
      const age = Date.now() - Date.parse(tsMatch[1]!);
      if (Number.isFinite(age) && age > LOCK_STALE_MS) stale = true;
    }
    if (!stale) return false;
    try { rmSync(this.lockPath, { force: true }); } catch { return false; }
    return true;
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

  // 2a. set_facts — bulk variant: multiple facts on one entity sharing a source.
  // The common pattern (one page → N fields) gets one MCP round-trip instead of N.
  // Atomic: either every fact lands, or none do.
  setFacts(input: {
    entity_id: string;
    source: Source;
    facts: Array<{
      field: string;
      value: unknown;
      confidence?: number;
      observed_at?: string;
    }>;
  }): { fact_ids: string[] } {
    const release = this.acquireLock();
    try {
      const schema = this.schema();
      const source = validateSource(input.source);

      // Validate everything BEFORE appending — atomicity.
      for (const f of input.facts) {
        const def = schema.fields[f.field];
        if (!def && !schema.allow_unknown_fields) {
          throw new FrameError(
            "UnknownField",
            `field ${f.field} is not in schema.yml`,
          );
        }
        if (def) validateValue(f.field, def, f.value);
        if (f.confidence !== undefined) {
          if (
            typeof f.confidence !== "number" ||
            f.confidence < 0 ||
            f.confidence > 1
          ) {
            throw new FrameError("InvalidConfidence", `confidence must be in [0, 1]`);
          }
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

      const fact_ids: string[] = [];
      for (const f of input.facts) {
        const fact_id = uuid();
        fact_ids.push(fact_id);
        appendEvent(this.eventsPath, {
          id: uuid(),
          ts: now(),
          type: "fact.set",
          agent: this.agent,
          payload: {
            fact_id,
            entity_id: input.entity_id,
            field: f.field,
            value: f.value,
            source,
            ...(f.confidence !== undefined ? { confidence: f.confidence } : {}),
            ...(f.observed_at ? { observed_at: f.observed_at } : {}),
          },
        } as FrameEvent);
      }
      this.project();
      return { fact_ids };
    } finally {
      release();
    }
  }

  // 2b. add_entity_with_facts — combines entity creation with N facts in one call.
  // Highest-throughput primitive for the common pattern: "I just read a page; here is
  // an entity with these N fields." One round-trip instead of N+1.
  //
  // Single lock acquisition + single projection: a concurrent writer cannot
  // observe an entity that exists with no facts attached (which used to be
  // possible while addEntity released its lock before setFacts re-acquired).
  addEntityWithFacts(input: {
    entity_id?: string;
    source: Source;
    facts: Array<{
      field: string;
      value: unknown;
      confidence?: number;
      observed_at?: string;
    }>;
  }): { entity_id: string; fact_ids: string[] } {
    const release = this.acquireLock();
    try {
      const schema = this.schema();
      const source = validateSource(input.source);

      const entity_id = input.entity_id ?? `e-${uuid().slice(0, 8)}`;
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(entity_id)) {
        throw new FrameError(
          "InvalidEntityId",
          `entity_id must match [a-z0-9][a-z0-9_-]*: ${JSON.stringify(entity_id)}`,
        );
      }

      // Validate every fact BEFORE appending anything — atomicity. If one is
      // invalid, neither the entity nor any fact lands.
      for (const f of input.facts) {
        const def = schema.fields[f.field];
        if (!def && !schema.allow_unknown_fields) {
          throw new FrameError(
            "UnknownField",
            `field ${f.field} is not in schema.yml`,
          );
        }
        if (def) validateValue(f.field, def, f.value);
        if (f.confidence !== undefined) {
          if (
            typeof f.confidence !== "number" ||
            f.confidence < 0 ||
            f.confidence > 1
          ) {
            throw new FrameError("InvalidConfidence", `confidence must be in [0, 1]`);
          }
        }
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

      const fact_ids: string[] = [];
      for (const f of input.facts) {
        const fact_id = uuid();
        fact_ids.push(fact_id);
        appendEvent(this.eventsPath, {
          id: uuid(),
          ts: now(),
          type: "fact.set",
          agent: this.agent,
          payload: {
            fact_id,
            entity_id,
            field: f.field,
            value: f.value,
            source,
            ...(f.confidence !== undefined ? { confidence: f.confidence } : {}),
            ...(f.observed_at ? { observed_at: f.observed_at } : {}),
          },
        } as FrameEvent);
      }
      this.project();
      return { entity_id, fact_ids };
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
      | { mode: "entity"; entity_id: string; include_sources?: boolean }
      | { mode: "all"; include_sources?: boolean }
      | { mode: "field"; field: string; value?: unknown; include_sources?: boolean }
      | { mode: "sql"; sql: string },
  ): { rows: Row[]; total: number } {
    if (!existsSync(this.dbPath)) this.project();

    const db = new Database(this.dbPath, { readonly: true });
    type DbRow = { entity_id: string; fields_json: string; invalid_json: string | null };

    // Fetch primary sources for the given entity_ids and zip them onto each row.
    // Only used when include_sources is true.
    const annotateSources = (rows: Row[]): Row[] => {
      if (rows.length === 0) return rows;
      const placeholders = rows.map(() => "?").join(",");
      const stmt = db.prepare(
        `SELECT entity_id, field, source_url, source_retrieved_at, source_title, source_archive_url, source_excerpt
           FROM facts
          WHERE deprecated = 0 AND entity_id IN (${placeholders})`,
      );
      const sources = stmt.all<{
        entity_id: string;
        field: string;
        source_url: string;
        source_retrieved_at: string;
        source_title: string | null;
        source_archive_url: string | null;
        source_excerpt: string | null;
      }>(...rows.map((r) => r.entity_id));
      const byEntity: Record<string, Record<string, Source>> = {};
      for (const s of sources) {
        const ent = byEntity[s.entity_id] ?? {};
        const src: Source = { url: s.source_url, retrieved_at: s.source_retrieved_at };
        if (s.source_title) src.title = s.source_title;
        if (s.source_archive_url) src.archive_url = s.source_archive_url;
        if (s.source_excerpt) src.excerpt = s.source_excerpt;
        ent[s.field] = src;
        byEntity[s.entity_id] = ent;
      }
      return rows.map((r) => ({ ...r, sources: byEntity[r.entity_id] ?? {} }));
    };

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
          const rows = [rowFromDb(r)];
          return { rows: input.include_sources ? annotateSources(rows) : rows, total: 1 };
        }
        case "all": {
          const stmt = db.prepare(
            "SELECT entity_id, fields_json, invalid_json FROM rows ORDER BY entity_id",
          );
          const rs = stmt.all<DbRow>().map(rowFromDb);
          return {
            rows: input.include_sources ? annotateSources(rs) : rs,
            total: rs.length,
          };
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
          return {
            rows: input.include_sources ? annotateSources(filtered) : filtered,
            total: filtered.length,
          };
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
    // Pass events with their source line numbers so the projector can locate
    // referential errors back to events.ndjson.
    return writeProjection(
      this.dir,
      readEventsWithLines(this.eventsPath),
      this.schema(),
    );
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
