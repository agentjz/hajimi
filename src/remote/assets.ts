import fs from "node:fs/promises";
import path from "node:path";

const assetCache = new Map<string, string>();
const VENDOR_ASSET_CANDIDATES: Record<string, string[]> = {
  "vendor/marked.esm.js": [
    "../node_modules/marked/lib/marked.esm.js",
    "../../node_modules/marked/lib/marked.esm.js",
    "../../../node_modules/marked/lib/marked.esm.js",
  ],
  "vendor/purify.es.mjs": [
    "../node_modules/dompurify/dist/purify.es.mjs",
    "../../node_modules/dompurify/dist/purify.es.mjs",
    "../../../node_modules/dompurify/dist/purify.es.mjs",
  ],
};

export async function loadRemoteAsset(name: string): Promise<string> {
  const cached = assetCache.get(name);
  if (cached) {
    return cached;
  }

  for (const assetPath of resolveAssetPaths(name)) {
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

function resolveAssetPaths(name: string): string[] {
  const moduleDir = __dirname;
  const directAssetPaths = resolveAssetDirectories().map((directory) => path.join(directory, name));
  const vendorAssetPaths = (VENDOR_ASSET_CANDIDATES[name] ?? []).map((relativePath) =>
    path.resolve(moduleDir, relativePath),
  );
  return [...new Set([...directAssetPaths, ...vendorAssetPaths])];
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
