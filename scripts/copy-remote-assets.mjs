import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.join(rootDir, "src", "remote", "web");
const targetDir = process.argv[2]
  ? path.resolve(rootDir, process.argv[2])
  : path.join(rootDir, "dist", "remote-web");
const vendorAssets = [
  {
    source: path.join(rootDir, "node_modules", "marked", "lib", "marked.esm.js"),
    target: path.join(targetDir, "vendor", "marked.esm.js"),
  },
  {
    source: path.join(rootDir, "node_modules", "dompurify", "dist", "purify.es.mjs"),
    target: path.join(targetDir, "vendor", "purify.es.mjs"),
  },
];

await fs.mkdir(targetDir, { recursive: true });
await fs.cp(sourceDir, targetDir, {
  recursive: true,
  force: true,
});

for (const asset of vendorAssets) {
  await fs.mkdir(path.dirname(asset.target), { recursive: true });
  await fs.copyFile(asset.source, asset.target);
}
