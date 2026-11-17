import { defineConfig, devices } from "@playwright/test";

const WEB = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000";
const API = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:4000";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: WEB,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command:
        "set -a && [ -f .env ] && . ./.env; set +a && export DATABASE_URL=\"${DATABASE_URL:-postgres://localmeals:localmeals@127.0.0.1:5432/localmeals}\" LUNCH_CUTOFF_HOUR=23 LUNCH_CUTOFF_MINUTE=59 MOCK_PAYMENTS=true MOCK_WHATSAPP=true MOCK_AUTH=true && node --import tsx apps/api/src/index.ts",
      url: `${API}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command:
        "set -a && [ -f .env ] && . ./.env; set +a && export NEXT_PUBLIC_API_URL=http://127.0.0.1:4000 WEB_ORIGIN=http://127.0.0.1:3000 && npm run dev -w @localmeals/web",
      url: WEB,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
