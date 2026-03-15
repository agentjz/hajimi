import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.join(rootDir, "src", "remote", "web");
const targetDir = process.argv[2]
  ? path.resolve(rootDir, process.argv[2])
  : path.join(rootDir, "dist", "remote-web");

await fs.mkdir(targetDir, { recursive: true });
await fs.cp(sourceDir, targetDir, {
  recursive: true,
  force: true,
});
