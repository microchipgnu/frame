// `frame init [<name-or-path>]` — scaffold a new frame directory.
//
// Three forms, all do the same thing:
//   frame init my-frame    creates ./my-frame/ (must not exist or must be empty)
//   frame init             initializes cwd     (must be empty of frame files)
//   frame init .           same as no args
//
// Slug-shaped basename required (a-z, 0-9, underscore, hyphen). The dataset's
// canonical name is the directory's basename.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";
import { FrameError, PROTOCOL_VERSION } from "../types.js";
import { starterSchema } from "../schema.js";

export function init(args: string[]): void {
  const arg = args[0];

  // Resolve target directory.
  let dir: string;
  if (!arg || arg === ".") {
    dir = process.cwd();
  } else {
    dir = isAbsolute(arg) ? arg : join(process.cwd(), arg);
  }

  const name = basename(dir);
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
    throw new FrameError(
      "InvalidName",
      `frame init [<name-or-path>] — basename must be slug-shaped (a-z, 0-9, _ or -); got ${JSON.stringify(name)}`,
    );
  }

  // Allow init into an empty existing directory; refuse if it already has files.
  if (existsSync(dir)) {
    const contents = readdirSync(dir);
    if (contents.length > 0) {
      throw new FrameError(
        "DirNotEmpty",
        `${dir} already exists and is not empty (${contents.length} entries)`,
      );
    }
  } else {
    mkdirSync(dir, { recursive: true });
  }

  mkdirSync(join(dir, ".frame"), { recursive: true });

  // README.md — prose spec
  writeFileSync(
    join(dir, "README.md"),
    `# ${name}

One-paragraph description of what this frame contains, who it's for,
and the boundary that defines what belongs in it.

## In scope

- ...
- ...

## Out of scope

- ...
- ...

## Refresh policy

How often the dataset should be re-checked, and what triggers refresh.
`,
  );

  // schema.yml — the contract
  writeFileSync(join(dir, "schema.yml"), starterSchema(name));

  // events.ndjson — empty
  writeFileSync(join(dir, "events.ndjson"), "");

  // CHANGELOG.md
  writeFileSync(
    join(dir, "CHANGELOG.md"),
    `# Changelog

## ${new Date().toISOString().slice(0, 10)}

- Frame initialized (protocol ${PROTOCOL_VERSION}).
`,
  );

  // .gitattributes — tells git how to merge events.ndjson and rows projection
  writeFileSync(
    join(dir, ".gitattributes"),
    `events.ndjson merge=union
.frame/** -diff -merge linguist-generated=true
`,
  );

  // .gitignore — keep derived artifacts out of git
  writeFileSync(join(dir, ".gitignore"), `.frame/\n`);

  // git init (only if not already a repo — running inside an existing repo is fine)
  if (!existsSync(join(dir, ".git"))) {
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "pipe" });
      execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "pipe" });
      execFileSync(
        "git",
        ["commit", "-q", "-m", `frame ${name} initialized`],
        { cwd: dir, stdio: "pipe" },
      );
    } catch (e) {
      console.warn("(git init/commit skipped:", String(e), ")");
    }
  }

  // Helpful next-step suggestions, scoped to whether the user is already in the dir.
  const inDir = process.cwd() === dir;
  const rel = inDir ? "." : relative(process.cwd(), dir);
  console.log(`◇ created ${dir}`);
  console.log(`  edit ${rel === "." ? "" : rel + "/"}README.md and ${rel === "." ? "" : rel + "/"}schema.yml`);
  console.log(`  then: ${inDir ? "frame init-mcp" : `cd ${rel} && frame init-mcp`}`);
}
