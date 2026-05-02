// events.ndjson read / write / append. Append-only, never modified.
// See PROTOCOL.md § Event envelope.

import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { FrameError, type FrameEvent } from "./types.js";

export function readEvents(path: string): FrameEvent[] {
  return readEventsWithLines(path).map((t) => t.event);
}

// Same as readEvents but also returns the 1-based line number each event came
// from. Used by the projector so referential errors can point at the offending
// line in events.ndjson.
export function readEventsWithLines(
  path: string,
): Array<{ event: FrameEvent; line: number }> {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  if (!raw) return [];
  const out: Array<{ event: FrameEvent; line: number }> = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (e) {
      throw new FrameError(
        "CorruptEvent",
        `events.ndjson:${i + 1} is not valid JSON: ${e}`,
      );
    }
    out.push({ event: validateEnvelope(parsed, i + 1), line: i + 1 });
  }
  return out;
}

export function appendEvent(path: string, event: FrameEvent): void {
  if (!existsSync(path)) writeFileSync(path, "");
  appendFileSync(path, JSON.stringify(event) + "\n");
}

function validateEnvelope(raw: unknown, line: number): FrameEvent {
  if (typeof raw !== "object" || raw === null) {
    throw new FrameError("CorruptEvent", `events.ndjson:${line} is not an object`);
  }
  const obj = raw as Record<string, unknown>;
  for (const k of ["id", "ts", "type", "agent", "payload"] as const) {
    if (obj[k] === undefined) {
      throw new FrameError(
        "CorruptEvent",
        `events.ndjson:${line} missing required field "${k}"`,
      );
    }
  }
  if (typeof obj.id !== "string") {
    throw new FrameError("CorruptEvent", `events.ndjson:${line} id must be string`);
  }
  if (typeof obj.ts !== "string" || Number.isNaN(Date.parse(obj.ts))) {
    throw new FrameError("CorruptEvent", `events.ndjson:${line} ts must be ISO 8601`);
  }
  if (typeof obj.type !== "string") {
    throw new FrameError("CorruptEvent", `events.ndjson:${line} type must be string`);
  }
  if (typeof obj.agent !== "string") {
    throw new FrameError(
      "CorruptEvent",
      `events.ndjson:${line} agent must be string`,
    );
  }
  if (typeof obj.payload !== "object" || obj.payload === null) {
    throw new FrameError(
      "CorruptEvent",
      `events.ndjson:${line} payload must be an object`,
    );
  }
  return obj as unknown as FrameEvent;
}

// Generate a fresh UUID v4 (Bun + Node 19+ have crypto.randomUUID).
export function uuid(): string {
  return crypto.randomUUID();
}

// Returns a monotonic ISO 8601 timestamp. If called twice in the same ms, the
// second call adds microseconds in fraction form so events stay ordered.
let lastTs = 0;
export function now(): string {
  let t = Date.now();
  if (t <= lastTs) t = lastTs + 1;
  lastTs = t;
  return new Date(t).toISOString();
}
