// `frame query <name> [--all|--entity <id>|--field <f>=<v>|--sql <sql>]`

import { Frame } from "../frame.js";
import { resolveFrameDir } from "./util.js";

export function query(args: string[]): void {
  const dir = resolveFrameDir(args[0]);
  const frame = new Frame(dir);

  const rest = args.slice(1);
  let result;

  if (rest.includes("--all") || rest.length === 0) {
    result = frame.query({ mode: "all" });
  } else if (rest[0] === "--entity") {
    const id = rest[1];
    if (!id) {
      console.error("usage: frame query <name> --entity <id>");
      process.exit(1);
    }
    result = frame.query({ mode: "entity", entity_id: id });
  } else if (rest[0] === "--field") {
    const fv = rest[1];
    if (!fv) {
      console.error("usage: frame query <name> --field <field>[=<value>]");
      process.exit(1);
    }
    const eq = fv.indexOf("=");
    if (eq === -1) {
      result = frame.query({ mode: "field", field: fv });
    } else {
      result = frame.query({
        mode: "field",
        field: fv.slice(0, eq),
        value: fv.slice(eq + 1),
      });
    }
  } else if (rest[0] === "--sql") {
    const sql = rest.slice(1).join(" ");
    if (!sql) {
      console.error("usage: frame query <name> --sql <statement>");
      process.exit(1);
    }
    result = frame.query({ mode: "sql", sql });
  } else {
    console.error("usage: frame query <name> [--all|--entity <id>|--field <f>[=<v>]|--sql <sql>]");
    process.exit(1);
  }

  // emit one row per line — caller can pipe to jq
  for (const r of result.rows) {
    process.stdout.write(JSON.stringify(r) + "\n");
  }
  process.stderr.write(`◇ ${result.total} rows\n`);
}
