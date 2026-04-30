// Source validation. See PROTOCOL.md § Source schema.

import { FrameError, type Source } from "./types.ts";

export function validateSource(s: unknown): Source {
  if (typeof s !== "object" || s === null) {
    throw new FrameError("MissingSource", "source must be an object");
  }
  const obj = s as Record<string, unknown>;

  if (typeof obj.url !== "string" || !obj.url) {
    throw new FrameError("MissingSource", "source.url is required");
  }
  if (!/^https?:\/\//.test(obj.url)) {
    throw new FrameError(
      "MissingSource",
      `source.url must be http(s): ${JSON.stringify(obj.url)}`,
    );
  }
  if (typeof obj.retrieved_at !== "string" || !obj.retrieved_at) {
    throw new FrameError(
      "MissingSource",
      "source.retrieved_at is required (ISO 8601)",
    );
  }
  if (Number.isNaN(Date.parse(obj.retrieved_at))) {
    throw new FrameError(
      "MissingSource",
      `source.retrieved_at not parseable: ${JSON.stringify(obj.retrieved_at)}`,
    );
  }

  const out: Source = {
    url: obj.url,
    retrieved_at: obj.retrieved_at,
  };
  if (typeof obj.title === "string") out.title = obj.title;
  if (typeof obj.archive_url === "string") out.archive_url = obj.archive_url;
  if (typeof obj.excerpt === "string") out.excerpt = obj.excerpt;
  return out;
}
