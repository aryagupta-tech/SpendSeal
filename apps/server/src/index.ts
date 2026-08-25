import "./env.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDatabase, runMigrations } from "./db/client.js";
import { AgentRailStore } from "./store.js";

const config = loadConfig();
const { pool } = createDatabase(config.databaseUrl);
await runMigrations(pool);
const store = new AgentRailStore(pool);
const { app } = createApp(config, store);

const server = app.listen(config.port, config.host, () => {
  console.log(JSON.stringify({ level: "info", event: "server_started", bind: `http://${config.host}:${config.port}`, publicOrigin: config.publicBaseUrl, mcp: `${config.publicBaseUrl}/mcp`, database: "postgresql" }));
});

async function shutdown(signal: string) {
  console.log(JSON.stringify({ level: "info", event: "shutdown_started", signal }));
  server.close(async () => { await pool.end(); process.exit(0); });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
