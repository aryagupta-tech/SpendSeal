import fs from "node:fs";
import path from "node:path";
import { config } from "dotenv";

const candidates = [path.resolve(process.cwd(), ".env"), path.resolve(process.cwd(), "../../.env")];
const envFile = candidates.find((candidate) => fs.existsSync(candidate));
if (envFile) config({ path: envFile, quiet: true });
