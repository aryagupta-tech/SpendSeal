import fs from "node:fs";
import path from "node:path";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";
import * as schema from "./schema.js";

export type SpendSealDb = NodePgDatabase<typeof schema>;

export function createDatabase(databaseUrl: string): { pool: Pool; db: SpendSealDb } {
  const pool = new Pool({ connectionString: databaseUrl, max: 12, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });
  pool.on("error", (error) => console.error(JSON.stringify({ level: "error", event: "postgres_pool_error", message: error.message })));
  return { pool, db: drizzle(pool, { schema }) };
}

export async function runMigrations(pool: Pool): Promise<void> {
  const candidates = [path.resolve(process.cwd(), "apps/server/drizzle"), path.resolve(process.cwd(), "drizzle")];
  const directory = candidates.find((candidate) => fs.existsSync(candidate));
  if (!directory) throw new Error(`Migration directory not found. Checked: ${candidates.join(", ")}`);
  const files = fs.readdirSync(directory).filter((name) => name.endsWith(".sql")).sort();
  await pool.query("CREATE TABLE IF NOT EXISTS agentrail_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  for (const name of files) {
    const applied = await pool.query("SELECT 1 FROM agentrail_migrations WHERE name = $1", [name]);
    if (applied.rowCount) continue;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(fs.readFileSync(path.join(directory, name), "utf8"));
      await client.query("INSERT INTO agentrail_migrations(name) VALUES ($1) ON CONFLICT DO NOTHING", [name]);
      await client.query("COMMIT");
      console.log(JSON.stringify({ level: "info", event: "migration_applied", migration: name }));
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

export async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
