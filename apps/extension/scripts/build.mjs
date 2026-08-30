import { build } from "tsup";
import { cp, mkdir, rename, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { ZipArchive } from "archiver";
const root = path.resolve(import.meta.dirname, "..");
await rm(path.join(root, "dist"), { recursive: true, force: true });
await mkdir(path.join(root, "dist"), { recursive: true });
for (const entry of ["service-worker", "content", "sidepanel"]) {
  await build({ entry: [path.join(root, `src/${entry}.ts`)], outDir: path.join(root, "dist"), format: ["iife"], platform: "browser", target: "chrome120", bundle: true, minify: false, sourcemap: false, clean: false });
  await rename(path.join(root, "dist", `${entry}.global.js`), path.join(root, "dist", `${entry}.js`));
}
for (const file of ["manifest.json", "sidepanel.html", "sidepanel.css"]) await cp(path.join(root, "static", file), path.join(root, "dist", file));
const zipTargets = [
  path.resolve(root, "../web/dist/downloads/spendseal-extension.zip"),
  path.resolve(root, "../web/public/downloads/spendseal-extension.zip"),
];
for (const target of zipTargets) {
  await mkdir(path.dirname(target), { recursive: true });
  await new Promise((resolve, reject) => {
    const output = createWriteStream(target); const archive = new ZipArchive({ zlib: { level: 9 } });
    output.on("close", resolve); output.on("error", reject); archive.on("error", reject);
    archive.pipe(output); archive.directory(path.join(root, "dist"), false); void archive.finalize();
  });
}
console.log(`SpendSeal extension built at ${path.join(root, "dist")}`);
