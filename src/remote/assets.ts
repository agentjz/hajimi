import fs from "node:fs/promises";
import path from "node:path";

const assetCache = new Map<string, string>();

export async function loadRemoteAsset(name: string): Promise<string> {
  const cached = assetCache.get(name);
  if (cached) {
    return cached;
  }

  for (const directory of resolveAssetDirectories()) {
    const assetPath = path.join(directory, name);
    try {
      const content = await fs.readFile(assetPath, "utf8");
      assetCache.set(name, content);
      return content;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  throw new Error(`Remote asset not found: ${name}`);
}

function resolveAssetDirectories(): string[] {
  const moduleDir = __dirname;
  const candidates = [
    path.join(moduleDir, "web"),
    path.join(moduleDir, "remote-web"),
    path.resolve(moduleDir, "../../../src/remote/web"),
    path.resolve(moduleDir, "../src/remote/web"),
  ];

  return [...new Set(candidates)];
}
