/** Writes apps/api/openapi.json from the route contracts: `npm run openapi -w @localmeals/api`. */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildOpenApi } from "./build.js";
import { allOperations } from "./operations.js";

export const SPEC_PATH = join(dirname(fileURLToPath(import.meta.url)), "../../openapi.json");

export function renderSpec(): string {
  const pkg = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../package.json"), "utf8"),
  ) as { version: string };
  return `${JSON.stringify(buildOpenApi(allOperations, pkg.version), null, 2)}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(SPEC_PATH, renderSpec());
  console.log(`wrote ${SPEC_PATH} (${allOperations.length} operations)`);
}
