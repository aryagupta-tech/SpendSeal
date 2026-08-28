import "./apps/server/src/env.js";
import type { Request, Response } from "express";
import { createApp } from "./apps/server/src/app.js";
import { loadConfig } from "./apps/server/src/config.js";
import { createDatabase, runMigrations } from "./apps/server/src/db/client.js";
import { SpendSealStore } from "./apps/server/src/store.js";

type Application = ReturnType<typeof createApp>["app"];

let applicationPromise: Promise<Application> | undefined;

async function initialize(): Promise<Application> {
  const config = loadConfig();
  const { pool } = createDatabase(config.databaseUrl);
  try {
    await runMigrations(pool);
    return createApp(config, new SpendSealStore(pool)).app;
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
}

export default async function handler(req: Request, res: Response): Promise<void> {
  try {
    applicationPromise ??= initialize();
    const app = await applicationPromise;
    app(req, res);
  } catch (error) {
    applicationPromise = undefined;
    console.error(JSON.stringify({
      level: "error",
      event: "serverless_initialization_failed",
      message: error instanceof Error ? error.message : "Unknown error",
    }));
    if (!res.headersSent) {
      res.status(503).json({ error: { code: "SERVICE_UNAVAILABLE", message: "SpendSeal is starting or its database is unavailable." } });
    }
  }
}
