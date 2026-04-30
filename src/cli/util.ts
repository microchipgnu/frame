// CLI helpers.

import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export function resolveFrameDir(arg: string | undefined): string {
  if (!arg) {
    console.error("error: frame name or path required");
    process.exit(1);
  }
  const dir = isAbsolute(arg) ? arg : join(process.cwd(), arg);
  if (!existsSync(join(dir, "schema.yml"))) {
    console.error(`error: no schema.yml at ${dir} — is this a frame?`);
    process.exit(1);
  }
  return dir;
}
