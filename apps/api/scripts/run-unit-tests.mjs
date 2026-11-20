import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const files = [
  "src/httpErrors.test.ts",
  "src/prodConfig.test.ts",
  "src/http/orderViews.test.ts",
  "src/http/orderOwnership.test.ts",
  "src/uploads.test.ts",
  "src/soloKitchen.test.ts",
  "src/services/turnoverReports.test.ts",
  "src/services/publicCookDto.test.ts",
];

const result = spawnSync(
  process.execPath,
  ["--import", "tsx", "--test", "--test-concurrency=1", ...files],
  { cwd: root, stdio: "inherit", env: process.env },
);

process.exit(result.status ?? 1);
