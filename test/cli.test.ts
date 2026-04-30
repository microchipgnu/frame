// CLI ergonomics: cwd default and init-mcp.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveFrameDir, splitPathAndFlags } from "../src/cli/util.js";
import { initMcp } from "../src/cli/init-mcp.js";
import { init } from "../src/cli/init.js";
import { render } from "../src/cli/render.js";
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

  test("init does NOT create a nested git repo when run inside an existing repo", () => {
    // Set up: a parent repo with a frame scaffolded into a subdir.
    const parent = join(TMP, "init-multi-git");
    rmSync(parent, { recursive: true, force: true });
    mkdirSync(parent, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: parent, stdio: "pipe" });

    process.chdir(realpathSync(parent));
    init(["datasets/alpha"]);

    // The frame must NOT have its own .git/ — the parent repo tracks it.
    expect(existsSync(join(parent, "datasets/alpha/.git"))).toBe(false);
    // But the frame's other files must exist.
    expect(existsSync(join(parent, "datasets/alpha/schema.yml"))).toBe(true);
    expect(existsSync(join(parent, "datasets/alpha/events.ndjson"))).toBe(true);

    // And a second frame in the same parent repo also avoids nesting.
    init(["datasets/beta"]);
    expect(existsSync(join(parent, "datasets/beta/.git"))).toBe(false);
  });

  test("init DOES create a fresh repo when no ancestor git exists", () => {
    const dir = join(TMP, "init-fresh-git");
    rmSync(dir, { recursive: true, force: true });
    process.chdir(realpathSync(TMP));
    init([dir]);
    expect(existsSync(join(dir, ".git"))).toBe(true);
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

  test("multi-frame: cwd not a frame but children are — emits multi-server config", () => {
    const root = join(TMP, "multi-root");
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    // Make two nested frames
    makeNestedFrame(root, "datasets/alpha");
    makeNestedFrame(root, "datasets/beta");
    process.chdir(realpathSync(root));
    initMcp([]);
    const cfg = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));
    const names = Object.keys(cfg.mcpServers).sort();
    expect(names).toEqual(["frame-datasets-alpha", "frame-datasets-beta"]);
    expect(cfg.mcpServers["frame-datasets-alpha"].args).toEqual([
      "-y",
      "@frames-ag/frame",
      "serve",
      "datasets/alpha",
    ]);
  });

  test("multi-frame: root frame + nested frames — registers all", () => {
    const root = join(TMP, "multi-with-root");
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, "schema.yml"),
      `frame_protocol: "${PROTOCOL_VERSION}"\nname: root\nfields:\n  name:\n    type: string\n`,
    );
    writeFileSync(join(root, "events.ndjson"), "");
    makeNestedFrame(root, "datasets/alpha");
    process.chdir(realpathSync(root));
    initMcp([]);
    const cfg = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));
    expect(Object.keys(cfg.mcpServers).length).toBe(2);
    // The root frame entry has no positional path arg (cwd-default).
    expect(cfg.mcpServers["frame-root"].args).toEqual(["-y", "@frames-ag/frame", "serve"]);
    expect(cfg.mcpServers["frame-datasets-alpha"].args).toEqual([
      "-y",
      "@frames-ag/frame",
      "serve",
      "datasets/alpha",
    ]);
  });

  test("multi-frame: errors when no frames anywhere", () => {
    const root = join(TMP, "no-frames");
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    process.chdir(realpathSync(root));
    expect(() => initMcp([])).toThrow(/No schema.yml/);
  });
});

describe("splitPathAndFlags", () => {
  test("first arg is path when not a flag", () => {
    expect(splitPathAndFlags(["my-frame", "--all"])).toEqual({
      path: "my-frame",
      flags: ["--all"],
    });
  });

  test("first arg is undefined when a flag", () => {
    expect(splitPathAndFlags(["--all"])).toEqual({
      path: undefined,
      flags: ["--all"],
    });
  });

  test("empty args", () => {
    expect(splitPathAndFlags([])).toEqual({ path: undefined, flags: [] });
  });
});

describe("render", () => {
  test("single frame writes index.html with entity table", () => {
    const dir = makeFrame("render-single");
    process.chdir(dir);
    // Add an entity so the table isn't empty
    const { Frame } = require("../src/frame.js");
    const f = new Frame(dir, { agent: "human:test" });
    f.addEntity({ entity_id: "acme" });
    f.setFact({
      entity_id: "acme",
      field: "name",
      value: "Acme",
      source: { url: "https://example.com", retrieved_at: "2026-04-30T00:00:00Z", excerpt: "Acme stuff" },
    });
    render([]);
    const html = readFileSync(join(dir, "index.html"), "utf8");
    expect(html).toContain("<table>");
    expect(html).toContain("acme");
    expect(html).toContain("Acme");
    expect(html).toContain("https://example.com");
    expect(html).toContain("Acme stuff");
  });

  test("multi-frame writes a root index.html linking to each frame", () => {
    const root = join(TMP, "render-multi");
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    makeNestedFrame(root, "datasets/alpha");
    makeNestedFrame(root, "datasets/beta");
    process.chdir(realpathSync(root));
    render([]);
    expect(existsSync(join(root, "index.html"))).toBe(true);
    expect(existsSync(join(root, "datasets/alpha/index.html"))).toBe(true);
    expect(existsSync(join(root, "datasets/beta/index.html"))).toBe(true);
    const rootHtml = readFileSync(join(root, "index.html"), "utf8");
    expect(rootHtml).toContain("datasets/alpha/index.html");
    expect(rootHtml).toContain("datasets/beta/index.html");
  });

  test("errors when no frames anywhere", () => {
    const empty = join(TMP, "render-empty");
    rmSync(empty, { recursive: true, force: true });
    mkdirSync(empty, { recursive: true });
    process.chdir(realpathSync(empty));
    expect(() => render([])).toThrow(/No schema.yml/);
  });
});

function makeNestedFrame(root: string, relPath: string): void {
  const dir = join(root, relPath);
  mkdirSync(dir, { recursive: true });
  const name = relPath.replace(/[^a-z0-9_-]/gi, "-");
  writeFileSync(
    join(dir, "schema.yml"),
    `frame_protocol: "${PROTOCOL_VERSION}"\nname: ${name}\nfields:\n  name:\n    type: string\n`,
  );
  writeFileSync(join(dir, "events.ndjson"), "");
}
