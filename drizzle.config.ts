import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./apps/server/src/db/schema.ts",
  out: "./apps/server/drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgresql://agentrail:agentrail@localhost:5432/agentrail",
  },
  strict: true,
  verbose: true,
});
