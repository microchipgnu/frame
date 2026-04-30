// schema.yml parsing + per-field type validation.
// See PROTOCOL.md § schema.yml.

import { readFileSync } from "node:fs";
import { parse as parseYaml, stringify as yamlStringify } from "yaml";
import {
  FrameError,
  type FieldDef,
  type FieldType,
  type FrameSchema,
  PROTOCOL_VERSION,
} from "./types.js";

const FIELD_TYPES: ReadonlySet<FieldType> = new Set([
  "string",
  "int",
  "float",
  "bool",
  "date",
  "url",
  "enum",
]);

export function loadSchema(path: string): FrameSchema {
  const raw = readFileSync(path, "utf8");
  const parsed = parseYaml(raw);
  return validateSchema(parsed);
}

export function validateSchema(s: unknown): FrameSchema {
  if (typeof s !== "object" || s === null) {
    throw new FrameError("InvalidSchema", "schema.yml must be an object");
  }
  const obj = s as Record<string, unknown>;

  if (typeof obj.frame_protocol !== "string") {
    throw new FrameError(
      "InvalidSchema",
      `schema.frame_protocol required (e.g. "${PROTOCOL_VERSION}")`,
    );
  }
  const major = obj.frame_protocol.split(".")[0];
  const myMajor = PROTOCOL_VERSION.split(".")[0];
  if (major !== myMajor) {
    throw new FrameError(
      "ProtocolVersionMismatch",
      `frame protocol ${obj.frame_protocol} is incompatible with this implementation (${PROTOCOL_VERSION})`,
    );
  }

  if (typeof obj.name !== "string" || !/^[a-z0-9][a-z0-9_-]*$/.test(obj.name)) {
    throw new FrameError(
      "InvalidSchema",
      `schema.name must be slug-shaped: ${JSON.stringify(obj.name)}`,
    );
  }

  if (typeof obj.fields !== "object" || obj.fields === null) {
    throw new FrameError("InvalidSchema", "schema.fields must be an object");
  }

  const fields: Record<string, FieldDef> = {};
  for (const [name, def] of Object.entries(obj.fields)) {
    fields[name] = validateFieldDef(name, def);
  }

  return {
    frame_protocol: obj.frame_protocol,
    name: obj.name,
    description: typeof obj.description === "string" ? obj.description : undefined,
    entity_type: typeof obj.entity_type === "string" ? obj.entity_type : undefined,
    fields,
    tests: Array.isArray(obj.tests) ? (obj.tests as FrameSchema["tests"]) : undefined,
    allow_unknown_fields: obj.allow_unknown_fields === true,
  };
}

function validateFieldDef(name: string, def: unknown): FieldDef {
  if (typeof def !== "object" || def === null) {
    throw new FrameError("InvalidSchema", `field ${name} must be an object`);
  }
  const obj = def as Record<string, unknown>;
  if (typeof obj.type !== "string" || !FIELD_TYPES.has(obj.type as FieldType)) {
    throw new FrameError(
      "InvalidSchema",
      `field ${name}.type must be one of: ${[...FIELD_TYPES].join(", ")}`,
    );
  }
  const out: FieldDef = { type: obj.type as FieldType };
  if (obj.required === true) out.required = true;
  if (typeof obj.description === "string") out.description = obj.description;
  if (out.type === "enum") {
    if (!Array.isArray(obj.values) || obj.values.length === 0) {
      throw new FrameError(
        "InvalidSchema",
        `field ${name} type=enum requires non-empty values[]`,
      );
    }
    out.values = obj.values.map(String);
  }
  return out;
}

// Validate a value against a field's type. Throws FrameError("TypeMismatch") on failure.
export function validateValue(
  field: string,
  def: FieldDef,
  value: unknown,
): void {
  if (value === null || value === undefined) {
    if (def.required) {
      throw new FrameError(
        "TypeMismatch",
        `field ${field} is required, got ${value}`,
      );
    }
    return;
  }
  switch (def.type) {
    case "string":
      if (typeof value !== "string") {
        throw new FrameError("TypeMismatch", `field ${field} expects string, got ${typeof value}`);
      }
      break;
    case "int":
      if (typeof value !== "number" || !Number.isInteger(value)) {
        throw new FrameError("TypeMismatch", `field ${field} expects int`);
      }
      break;
    case "float":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new FrameError("TypeMismatch", `field ${field} expects finite number`);
      }
      break;
    case "bool":
      if (typeof value !== "boolean") {
        throw new FrameError("TypeMismatch", `field ${field} expects bool`);
      }
      break;
    case "date":
      if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
        throw new FrameError(
          "TypeMismatch",
          `field ${field} expects ISO 8601 date string`,
        );
      }
      break;
    case "url":
      if (typeof value !== "string" || !/^https?:\/\//.test(value)) {
        throw new FrameError("TypeMismatch", `field ${field} expects http(s) url`);
      }
      break;
    case "enum": {
      if (typeof value !== "string" || !def.values?.includes(value)) {
        throw new FrameError(
          "TypeMismatch",
          `field ${field} expects one of ${JSON.stringify(def.values)}, got ${JSON.stringify(value)}`,
        );
      }
      break;
    }
  }
}

// Generate a starter schema.yml string.
export function starterSchema(name: string): string {
  return yamlStringify({
    frame_protocol: PROTOCOL_VERSION,
    name,
    description: `One-line description of what ${name} contains.\n`,
    entity_type: "entity",
    fields: {
      name: { type: "string", required: true },
      url: { type: "url" },
    },
    tests: [],
  });
}
