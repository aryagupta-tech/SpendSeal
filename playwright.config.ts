import { defineConfig } from "@playwright/test";

// The config is evaluated in both the runner and worker processes, so a PID-derived
// port gives them different base URLs. Keep one explicit port for the whole run.
const e2ePort = Number(process.env.SPENDSEAL_E2E_PORT ?? 45_917);
const e2eOrigin = `http://localhost:${e2ePort}`;

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  use: { baseURL: e2eOrigin, trace: "retain-on-failure" },
  webServer: {
    command: "npm run start",
    url: `${e2eOrigin}/api/v1/health`,
    reuseExistingServer: false,
    env: { PORT: String(e2ePort), DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgresql://agentrail:agentrail-local-only@127.0.0.1:5432/agentrail_test", PUBLIC_BASE_URL: e2eOrigin, OAUTH_ISSUER: e2eOrigin, WEBAUTHN_ORIGIN: e2eOrigin, WEBAUTHN_RP_ID: "localhost", CREDENTIAL_ENCRYPTION_KEY: "CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk=", DEMO_MODE: "false" },
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
