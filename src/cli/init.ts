// `frame init <name>` — scaffold a new frame directory.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { PROTOCOL_VERSION } from "../types.js";
import { starterSchema } from "../schema.js";

export function init(args: string[]): void {
  const arg = args[0];
  if (!arg) {
    console.error("usage: frame init <name-or-path>");
    process.exit(1);
  }
  const dir = isAbsolute(arg) ? arg : join(process.cwd(), arg);
  const name = basename(dir);
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
    console.error(
      `usage: frame init <name>   (basename must be slug-shaped: a-z, 0-9, _ or -)`,
    );
    process.exit(1);
  }
  if (existsSync(dir)) {
    console.error(`error: ${dir} already exists`);
    process.exit(1);
  }

  mkdirSync(dir, { recursive: true });
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

  // git init
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

  console.log(`◇ created ${dir}`);
  console.log(`  edit ${name}/README.md and ${name}/schema.yml`);
  console.log(`  then: frame serve ${name}`);
}
