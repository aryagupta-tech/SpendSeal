import "./env.js";
import { loadConfig } from "./config.js";
import { createDatabase, runMigrations } from "./db/client.js";
import { seedNovaDesk } from "./demo.js";
import { SpendSealService } from "./service.js";
import { SpendSealStore } from "./store.js";

const config = loadConfig();
if (!config.demoMode) throw new Error("Set DEMO_MODE=true before loading optional NovaDesk data");
const username = process.env.DEMO_OWNER_USERNAME;
if (!username) throw new Error("DEMO_OWNER_USERNAME must identify an existing passkey account");
const { pool } = createDatabase(config.databaseUrl);
try {
  await runMigrations(pool); const store = new SpendSealStore(pool); const user = await store.getUserByUsername(username);
  if (!user) throw new Error(`No SpendSeal user exists for ${username}; register a passkey first`);
  const result = await seedNovaDesk(store, new SpendSealService(store, config), user.id);
  console.log(JSON.stringify({ level: "info", event: "demo_seeded", merchantId: result.merchant.id, products: result.products.length }));
} finally { await pool.end(); }
