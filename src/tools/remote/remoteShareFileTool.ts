import fs from "node:fs/promises";
import path from "node:path";

import type { RemoteFileShareStore } from "../../remote/fileShares.js";
import { resolveUserPath } from "../../utils/fs.js";
import { okResult, parseArgs, readString } from "../shared.js";
import type { RegisteredTool } from "../types.js";

export function createRemoteShareFileTool(shareStore: RemoteFileShareStore): RegisteredTool {
  return {
    definition: {
      type: "function",
      function: {
        name: "remote_share_file",
        description: "Prepare a workspace file for download in the remote mobile UI.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Path to a file inside the current workspace.",
            },
          },
          required: ["path"],
          additionalProperties: false,
        },
      },
    },
    async execute(rawArgs, context) {
      const args = parseArgs(rawArgs);
      const requestedPath = readString(args.path, "path");
      const resolvedPath = resolveUserPath(requestedPath, context.cwd);
      const relativeToWorkspace = path.relative(context.cwd, resolvedPath);

      if (!relativeToWorkspace || relativeToWorkspace.startsWith("..") || path.isAbsolute(relativeToWorkspace)) {
        throw new Error(
          `Only files inside the current workspace can be shared. Requested: ${requestedPath}`,
        );
      }

      let stat;
      try {
        stat = await fs.stat(resolvedPath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          throw new Error(`File not found: ${requestedPath}`);
        }

        throw error;
      }

      if (!stat.isFile()) {
        throw new Error(`Only regular files can be shared: ${requestedPath}`);
      }

      const shared = await shareStore.createShare({
        sourcePath: resolvedPath,
        cwd: context.cwd,
      });

      return okResult(
        JSON.stringify(
          {
            ok: true,
            shareId: shared.shareId,
            fileName: shared.fileName,
            relativePath: shared.relativePath,
            size: shared.size,
            createdAt: shared.createdAt,
            downloadPath: shared.downloadPath,
          },
          null,
          2,
        ),
      );
    },
  };
}
