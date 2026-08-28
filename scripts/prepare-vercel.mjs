import fs from "node:fs";
import path from "node:path";

const source = path.resolve("apps/web/dist");
const destination = path.resolve("public");

if (!fs.existsSync(path.join(source, "index.html"))) {
  throw new Error("Frontend build was not found. Run the workspace build before preparing Vercel assets.");
}

fs.rmSync(destination, { recursive: true, force: true });
fs.cpSync(source, destination, { recursive: true });
console.log(`Prepared Vercel static assets in ${destination}`);
