// Core types for the frame protocol v0.1.0.
// See PROTOCOL.md for the canonical spec.

export const PROTOCOL_VERSION = "0.1.0";

// ─── Sources ─────────────────────────────────────────────────────────────────

export type Source = {
  url: string;
  retrieved_at: string;
  title?: string;
  archive_url?: string;
  excerpt?: string;
};

// ─── Schema ──────────────────────────────────────────────────────────────────

export type FieldType =
  | "string"
  | "int"
  | "float"
  | "bool"
  | "date"
  | "url"
  | "enum";

export type FieldDef = {
  type: FieldType;
  required?: boolean;
  values?: string[]; // for enum
  description?: string;
};

export type TestRule =
  | { name: string; field: string; rule: "enum"; allowed: string[] }
  | { name: string; field: string; rule: "regex"; pattern: string }
  | { name: string; field: string; rule: "range"; min?: number; max?: number };

export type FrameSchema = {
  frame_protocol: string;
  name: string;
  description?: string;
  entity_type?: string;
  fields: Record<string, FieldDef>;
  tests?: TestRule[];
  allow_unknown_fields?: boolean;
};

// ─── Events ──────────────────────────────────────────────────────────────────

export type EventType =
  | "entity.created"
  | "fact.set"
  | "fact.deprecated"
  | "evidence.attached"
  | "entity.removed";

export type AgentId = string; // "<kind>:<identifier>", e.g. "claude:opus-4.7"

export type EventEnvelope<P = unknown> = {
  id: string;
  ts: string;
  type: EventType | string; // string allows forward-compat unknown types
  agent: AgentId;
  payload: P;
};

export type EntityCreatedPayload = {
  entity_id: string;
};

export type FactSetPayload = {
  fact_id: string;
  entity_id: string;
  field: string;
  value: unknown;
  source: Source;
  confidence?: number;
  observed_at?: string;
};

export type FactDeprecatedPayload = {
  fact_id: string;
  reason: string;
};

export type EvidenceAttachedPayload = {
  fact_id: string;
  source: Source;
};

export type EntityRemovedPayload = {
  entity_id: string;
  reason: string;
};

export type FrameEvent =
  | EventEnvelope<EntityCreatedPayload> & { type: "entity.created" }
  | EventEnvelope<FactSetPayload> & { type: "fact.set" }
  | EventEnvelope<FactDeprecatedPayload> & { type: "fact.deprecated" }
  | EventEnvelope<EvidenceAttachedPayload> & { type: "evidence.attached" }
  | EventEnvelope<EntityRemovedPayload> & { type: "entity.removed" };

// ─── Projection ──────────────────────────────────────────────────────────────

export type Row = {
  entity_id: string;
  fields: Record<string, unknown>;
  invalid?: { reason: string }[];
};

export type ProjectionStats = {
  entity_count: number;
  fact_count: number;
  deprecated_count: number;
  invalid_row_count: number;
  duration_ms: number;
};

// ─── Errors ──────────────────────────────────────────────────────────────────

export class FrameError extends Error {
  override readonly name = "FrameError";
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}
