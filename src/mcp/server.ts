// MCP curation server. Wraps the Frame engine 1:1 over the MCP protocol.
// See MCP.md for the surface contract.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Frame } from "../frame.js";
import { FrameError, PROTOCOL_VERSION } from "../types.js";
import { readEvents } from "../events.js";

// Tool definitions. Mirrors MCP.md exactly.
const TOOLS = [
  {
    name: "add_entity",
    description:
      "Create a new entity. Required before set_fact on it. Returns the entity_id.",
    inputSchema: {
      type: "object",
      properties: {
        entity_id: {
          type: "string",
          description:
            "Optional. Slug-shaped (a-z0-9_-). Auto-generated if omitted.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "set_fact",
    description:
      "Set a field's value on an entity with required source. Last-write-wins by ts for (entity_id, field). Returns the fact_id.",
    inputSchema: {
      type: "object",
      properties: {
        entity_id: { type: "string" },
        field: { type: "string" },
        value: {},
        source: {
          type: "object",
          properties: {
            url: { type: "string" },
            retrieved_at: { type: "string" },
            title: { type: "string" },
            archive_url: { type: "string" },
            excerpt: { type: "string" },
          },
          required: ["url", "retrieved_at"],
        },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        observed_at: { type: "string" },
      },
      required: ["entity_id", "field", "value", "source"],
      additionalProperties: false,
    },
  },
  {
    name: "set_facts",
    description:
      "Bulk-set multiple facts on one entity sharing a single source. Use when you've read a page and want to extract N fields from it — one call instead of N. Atomic: either every fact lands or none do.",
    inputSchema: {
      type: "object",
      properties: {
        entity_id: { type: "string" },
        source: {
          type: "object",
          properties: {
            url: { type: "string" },
            retrieved_at: { type: "string" },
            title: { type: "string" },
            archive_url: { type: "string" },
            excerpt: { type: "string" },
          },
          required: ["url", "retrieved_at"],
        },
        facts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              field: { type: "string" },
              value: {},
              confidence: { type: "number", minimum: 0, maximum: 1 },
              observed_at: { type: "string" },
            },
            required: ["field", "value"],
          },
        },
      },
      required: ["entity_id", "source", "facts"],
      additionalProperties: false,
    },
  },
  {
    name: "add_entity_with_facts",
    description:
      "Combine entity creation and bulk fact-set in one call. Highest-throughput for the common pattern: one page read → one entity with N fields. Returns entity_id and all fact_ids.",
    inputSchema: {
      type: "object",
      properties: {
        entity_id: {
          type: "string",
          description: "Optional. Slug-shaped (a-z0-9_-). Auto-generated if omitted.",
        },
        source: {
          type: "object",
          properties: {
            url: { type: "string" },
            retrieved_at: { type: "string" },
            title: { type: "string" },
            archive_url: { type: "string" },
            excerpt: { type: "string" },
          },
          required: ["url", "retrieved_at"],
        },
        facts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              field: { type: "string" },
              value: {},
              confidence: { type: "number", minimum: 0, maximum: 1 },
              observed_at: { type: "string" },
            },
            required: ["field", "value"],
          },
        },
      },
      required: ["source", "facts"],
      additionalProperties: false,
    },
  },
  {
    name: "deprecate_fact",
    description:
      "Mark a previously-set fact as no longer trusted. Reverts the (entity, field) to the most recent prior non-deprecated fact, or unsets.",
    inputSchema: {
      type: "object",
      properties: {
        fact_id: { type: "string" },
        reason: { type: "string" },
      },
      required: ["fact_id", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "attach_evidence",
    description:
      "Add an additional source to an existing fact without changing the value.",
    inputSchema: {
      type: "object",
      properties: {
        fact_id: { type: "string" },
        source: {
          type: "object",
          properties: {
            url: { type: "string" },
            retrieved_at: { type: "string" },
            title: { type: "string" },
            archive_url: { type: "string" },
            excerpt: { type: "string" },
          },
          required: ["url", "retrieved_at"],
        },
      },
      required: ["fact_id", "source"],
      additionalProperties: false,
    },
  },
  {
    name: "remove_entity",
    description:
      "Remove an entity from the rows projection. The entity's history remains in events.ndjson.",
    inputSchema: {
      type: "object",
      properties: {
        entity_id: { type: "string" },
        reason: { type: "string" },
      },
      required: ["entity_id", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "query",
    description:
      "Read the current state of the frame. mode=all returns every row; mode=entity returns one; mode=field filters by a field; mode=sql runs a read-only SQL query against the SQLite index. Set include_sources=true on non-sql modes to attach each field's primary source. For full evidence including corroborating sources, query the `all_sources` view via mode=sql.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["all", "entity", "field", "sql"] },
        entity_id: { type: "string" },
        field: { type: "string" },
        value: {},
        sql: { type: "string" },
        include_sources: {
          type: "boolean",
          description: "Include primary source per field on each row. Ignored in mode=sql.",
        },
      },
      required: ["mode"],
      additionalProperties: false,
    },
  },
  {
    name: "project",
    description:
      "Force regeneration of the SQLite index and rows.ndjson from events.ndjson. Idempotent.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
];

// Resource URIs — read-only state.
const RESOURCES = [
  {
    uri: "frame://schema",
    name: "schema",
    description: "Parsed schema.yml",
    mimeType: "application/json",
  },
  {
    uri: "frame://readme",
    name: "readme",
    description: "README.md content",
    mimeType: "text/markdown",
  },
  {
    uri: "frame://changelog",
    name: "changelog",
    description: "CHANGELOG.md content",
    mimeType: "text/markdown",
  },
  {
    uri: "frame://recent-events",
    name: "recent-events",
    description: "Last 100 lines of events.ndjson, parsed",
    mimeType: "application/json",
  },
  {
    uri: "frame://rows",
    name: "rows",
    description: "Current rows projection (NDJSON)",
    mimeType: "application/x-ndjson",
  },
  {
    uri: "frame://stats",
    name: "stats",
    description: "Counts (entities, facts, deprecated, runs)",
    mimeType: "application/json",
  },
];

export async function startMcpServer(frameDir: string, agent: string): Promise<void> {
  const frame = new Frame(frameDir, { agent });

  const server = new Server(
    { name: "frame", version: PROTOCOL_VERSION },
    { capabilities: { tools: {}, resources: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    try {
      const result = await dispatch(frame, name, args as Record<string, unknown>);
      return {
        content: [
          { type: "text", text: JSON.stringify(result, null, 2) },
        ],
      };
    } catch (e) {
      if (e instanceof FrameError) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: { code: e.code, message: e.message, details: e.details ?? null },
              }),
            },
          ],
        };
      }
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: { code: "Unknown", message: String((e as any)?.message ?? e) },
            }),
          },
        ],
      };
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: RESOURCES,
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const uri = req.params.uri;
    return { contents: [readResource(frame, uri)] };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function dispatch(
  frame: Frame,
  name: string,
  args: Record<string, unknown>,
): unknown {
  switch (name) {
    case "add_entity":
      return frame.addEntity(args as { entity_id?: string });
    case "set_fact":
      return frame.setFact(args as Parameters<Frame["setFact"]>[0]);
    case "set_facts":
      return frame.setFacts(args as Parameters<Frame["setFacts"]>[0]);
    case "add_entity_with_facts":
      return frame.addEntityWithFacts(args as Parameters<Frame["addEntityWithFacts"]>[0]);
    case "deprecate_fact":
      return frame.deprecateFact(args as Parameters<Frame["deprecateFact"]>[0]);
    case "attach_evidence":
      return frame.attachEvidence(args as Parameters<Frame["attachEvidence"]>[0]);
    case "remove_entity":
      return frame.removeEntity(args as Parameters<Frame["removeEntity"]>[0]);
    case "query":
      return frame.query(args as Parameters<Frame["query"]>[0]);
    case "project":
      return frame.project();
    default:
      throw new FrameError("UnknownTool", `tool ${name} is not exposed`);
  }
}

function readResource(
  frame: Frame,
  uri: string,
): { uri: string; mimeType: string; text: string } {
  switch (uri) {
    case "frame://schema":
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(frame.schema(), null, 2),
      };
    case "frame://readme":
      return {
        uri,
        mimeType: "text/markdown",
        text: existsSync(join(frame.dir, "README.md"))
          ? readFileSync(join(frame.dir, "README.md"), "utf8")
          : "",
      };
    case "frame://changelog":
      return {
        uri,
        mimeType: "text/markdown",
        text: existsSync(join(frame.dir, "CHANGELOG.md"))
          ? readFileSync(join(frame.dir, "CHANGELOG.md"), "utf8")
          : "",
      };
    case "frame://recent-events": {
      const all = readEvents(join(frame.dir, "events.ndjson"));
      const recent = all.slice(-100);
      return { uri, mimeType: "application/json", text: JSON.stringify(recent, null, 2) };
    }
    case "frame://rows": {
      const r = frame.query({ mode: "all" });
      return {
        uri,
        mimeType: "application/x-ndjson",
        text: r.rows.map((row) => JSON.stringify(row)).join("\n"),
      };
    }
    case "frame://stats": {
      const events = readEvents(join(frame.dir, "events.ndjson"));
      const counts = {
        events_total: events.length,
        entities_created: events.filter((e) => e.type === "entity.created").length,
        entities_removed: events.filter((e) => e.type === "entity.removed").length,
        facts_set: events.filter((e) => e.type === "fact.set").length,
        facts_deprecated: events.filter((e) => e.type === "fact.deprecated").length,
        evidence_attached: events.filter((e) => e.type === "evidence.attached").length,
        events_size_bytes: existsSync(join(frame.dir, "events.ndjson"))
          ? statSync(join(frame.dir, "events.ndjson")).size
          : 0,
      };
      return { uri, mimeType: "application/json", text: JSON.stringify(counts, null, 2) };
    }
    default:
      throw new FrameError("UnknownResource", `resource ${uri} not exposed`);
  }
}
