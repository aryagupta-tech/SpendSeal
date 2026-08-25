import "./env.js";
import { loadConfig } from "./config.js";
import { createDatabase, runMigrations } from "./db/client.js";

const config = loadConfig();
const { pool } = createDatabase(config.databaseUrl);

try {
  await runMigrations(pool);
  console.log(JSON.stringify({ level: "info", event: "migrations_complete" }));
} finally {
  await pool.end();
}
