// CLI ergonomics: cwd default and init-mcp.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveFrameDir } from "../src/cli/util.js";
import { initMcp } from "../src/cli/init-mcp.js";
import { init } from "../src/cli/init.js";
import { PROTOCOL_VERSION } from "../src/types.js";

const TMP = "/tmp/frame-cli-test";

function makeFrame(name: string): string {
  const dir = join(TMP, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "schema.yml"),
    `frame_protocol: "${PROTOCOL_VERSION}"
name: ${name.replace(/[^a-z0-9_-]/g, "-")}
fields:
  name:
    type: string
    required: true
`,
  );
  writeFileSync(join(dir, "events.ndjson"), "");
  // process.cwd() resolves symlinks (on macOS, /tmp -> /private/tmp), so
  // return the canonical path for comparisons.
  return realpathSync(dir);
}

let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
});

afterEach(() => {
  process.chdir(originalCwd);
});

describe("cwd default", () => {
  test("resolveFrameDir(undefined) returns process.cwd() when it has schema.yml", () => {
    const dir = makeFrame("cwd-default");
    process.chdir(dir);
    expect(resolveFrameDir(undefined)).toBe(dir);
  });

  test("resolveFrameDir(absolute path) overrides cwd", () => {
    const a = makeFrame("override-a");
    const b = makeFrame("override-b");
    process.chdir(a);
    expect(resolveFrameDir(b)).toBe(b);
  });
});

describe("init", () => {
  test("init <name> creates a new directory with all scaffold files", () => {
    rmSync(join(TMP, "init-new"), { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
    process.chdir(realpathSync(TMP));
    init(["init-new"]);
    const dir = join(realpathSync(TMP), "init-new");
    expect(existsSync(join(dir, "schema.yml"))).toBe(true);
    expect(existsSync(join(dir, "events.ndjson"))).toBe(true);
    expect(existsSync(join(dir, "README.md"))).toBe(true);
    expect(existsSync(join(dir, ".gitattributes"))).toBe(true);
  });

  test("init . initializes the current empty directory", () => {
    const dir = join(TMP, "init-dot");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    process.chdir(realpathSync(dir));
    init(["."]);
    expect(existsSync(join(dir, "schema.yml"))).toBe(true);
  });

  test("init with no args initializes cwd", () => {
    const dir = join(TMP, "init-noargs");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    process.chdir(realpathSync(dir));
    init([]);
    expect(existsSync(join(dir, "schema.yml"))).toBe(true);
  });

  test("init refuses non-empty existing directory", () => {
    const dir = join(TMP, "init-nonempty");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "stray.txt"), "hello");
    process.chdir(realpathSync(TMP));
    expect(() => init(["init-nonempty"])).toThrow();
  });
});

describe("init-mcp", () => {
  test("writes .mcp.json with the expected shape", () => {
    const dir = makeFrame("init-mcp-shape");
    process.chdir(dir);
    initMcp([]);
    const target = join(dir, ".mcp.json");
    expect(existsSync(target)).toBe(true);
    const cfg = JSON.parse(readFileSync(target, "utf8"));
    const serverName = `frame-init-mcp-shape`;
    expect(cfg.mcpServers[serverName]).toBeDefined();
    expect(cfg.mcpServers[serverName].command).toBe("npx");
    expect(cfg.mcpServers[serverName].args).toEqual(["-y", "@frames-ag/frame", "serve"]);
  });

  test("--name overrides the default server name", () => {
    const dir = makeFrame("init-mcp-name");
    process.chdir(dir);
    initMcp(["--name", "custom-server"]);
    const cfg = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"));
    expect(cfg.mcpServers["custom-server"]).toBeDefined();
    expect(cfg.mcpServers["frame-init-mcp-name"]).toBeUndefined();
  });

  test("refuses to overwrite without --force", () => {
    const dir = makeFrame("init-mcp-overwrite");
    process.chdir(dir);
    writeFileSync(join(dir, ".mcp.json"), '{"existing": true}');
    expect(() => initMcp([])).toThrow(/already exists/);
    // unchanged
    expect(readFileSync(join(dir, ".mcp.json"), "utf8")).toBe('{"existing": true}');
  });
});
