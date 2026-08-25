import { defineConfig } from "@playwright/test";

const e2ePort = 45_000 + (process.pid % 1_000);
const e2eOrigin = `http://127.0.0.1:${e2ePort}`;

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  use: { baseURL: e2eOrigin, trace: "retain-on-failure" },
  webServer: {
    command: "npm run start",
    url: `${e2eOrigin}/api/v1/health`,
    reuseExistingServer: false,
    env: { PORT: String(e2ePort), DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgresql://agentrail:agentrail-local-only@127.0.0.1:5432/agentrail_test", PUBLIC_BASE_URL: e2eOrigin, OAUTH_ISSUER: e2eOrigin, WEBAUTHN_ORIGIN: e2eOrigin, WEBAUTHN_RP_ID: "127.0.0.1", CREDENTIAL_ENCRYPTION_KEY: "CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk=", DEMO_MODE: "false" },
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
