// `frame query <name> [--all|--entity <id>|--field <f>=<v>|--sql <sql>] [--with-sources]`

import { Frame } from "../frame.js";
import { resolveFrameDir } from "./util.js";

export function query(args: string[]): void {
  const dir = resolveFrameDir(args[0]);
  const frame = new Frame(dir);

  const rest = args.slice(1);
  const include_sources = rest.includes("--with-sources");
  // Strip the flag so positional parsing below isn't affected.
  const positional = rest.filter((a) => a !== "--with-sources");

  let result;

  if (positional.includes("--all") || positional.length === 0) {
    result = frame.query({ mode: "all", include_sources });
  } else if (positional[0] === "--entity") {
    const id = positional[1];
    if (!id) {
      console.error("usage: frame query <name> --entity <id> [--with-sources]");
      process.exit(1);
    }
    result = frame.query({ mode: "entity", entity_id: id, include_sources });
  } else if (positional[0] === "--field") {
    const fv = positional[1];
    if (!fv) {
      console.error("usage: frame query <name> --field <field>[=<value>] [--with-sources]");
      process.exit(1);
    }
    const eq = fv.indexOf("=");
    if (eq === -1) {
      result = frame.query({ mode: "field", field: fv, include_sources });
    } else {
      result = frame.query({
        mode: "field",
        field: fv.slice(0, eq),
        value: fv.slice(eq + 1),
        include_sources,
      });
    }
  } else if (positional[0] === "--sql") {
    const sql = positional.slice(1).join(" ");
    if (!sql) {
      console.error("usage: frame query <name> --sql <statement>");
      process.exit(1);
    }
    result = frame.query({ mode: "sql", sql });
  } else {
    console.error(
      "usage: frame query <name> [--all|--entity <id>|--field <f>[=<v>]|--sql <sql>] [--with-sources]",
    );
    process.exit(1);
  }

  // emit one row per line — caller can pipe to jq
  for (const r of result.rows) {
    process.stdout.write(JSON.stringify(r) + "\n");
  }
  process.stderr.write(`◇ ${result.total} rows\n`);
}
