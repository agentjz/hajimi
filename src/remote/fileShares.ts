import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { RemoteSharedFileDownload, RemoteSharedFileSummary } from "./types.js";

interface StoredRemoteFileShare {
  shareId: string;
  fileName: string;
  relativePath: string;
  size: number;
  createdAt: string;
  contentType: string;
  snapshotFile: string;
}

export class RemoteFileShareStore {
  constructor(private readonly rootDir: string) {}

  async createShare(options: {
    sourcePath: string;
    cwd: string;
  }): Promise<RemoteSharedFileSummary> {
    const stat = await fs.stat(options.sourcePath);
    if (!stat.isFile()) {
      throw new Error(`Cannot share non-file path: ${options.sourcePath}`);
    }

    await fs.mkdir(this.rootDir, { recursive: true });

    const shareId = crypto.randomUUID();
    const fileName = path.basename(options.sourcePath);
    const extension = path.extname(fileName);
    const snapshotFile = extension ? `${shareId}${extension}` : shareId;
    const createdAt = new Date().toISOString();
    const content = await fs.readFile(options.sourcePath);
    const record: StoredRemoteFileShare = {
      shareId,
      fileName,
      relativePath: toDisplayRelativePath(options.cwd, options.sourcePath),
      size: content.length,
      createdAt,
      contentType: inferContentType(fileName),
      snapshotFile,
    };

    await fs.writeFile(this.getSnapshotPath(snapshotFile), content);
    await fs.writeFile(this.getManifestPath(shareId), `${JSON.stringify(record, null, 2)}\n`, "utf8");

    return toSummary(record);
  }

  async getSharedFile(shareId: string): Promise<RemoteSharedFileDownload | null> {
    const record = await this.readManifest(shareId);
    if (!record) {
      return null;
    }

    try {
      const content = await fs.readFile(this.getSnapshotPath(record.snapshotFile));
      return {
        fileName: record.fileName,
        contentType: record.contentType,
        size: record.size,
        content,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }

      throw error;
    }
  }

  async getSharedFileSummary(shareId: string): Promise<RemoteSharedFileSummary | null> {
    const record = await this.readManifest(shareId);
    return record ? toSummary(record) : null;
  }

  private async readManifest(shareId: string): Promise<StoredRemoteFileShare | null> {
    try {
      const raw = await fs.readFile(this.getManifestPath(shareId), "utf8");
      return JSON.parse(raw) as StoredRemoteFileShare;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }

      throw error;
    }
  }

  private getManifestPath(shareId: string): string {
    return path.join(this.rootDir, `${shareId}.json`);
  }

  private getSnapshotPath(snapshotFile: string): string {
    return path.join(this.rootDir, snapshotFile);
  }
}

function toSummary(record: StoredRemoteFileShare): RemoteSharedFileSummary {
  return {
    shareId: record.shareId,
    fileName: record.fileName,
    relativePath: record.relativePath,
    size: record.size,
    createdAt: record.createdAt,
    downloadPath: `/api/files/${encodeURIComponent(record.shareId)}`,
  };
}

function toDisplayRelativePath(cwd: string, sourcePath: string): string {
  const relative = path.relative(cwd, sourcePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return normalizeSlashes(sourcePath);
  }

  return normalizeSlashes(relative);
}

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, "/");
}

function inferContentType(fileName: string): string {
  const extension = path.extname(fileName).toLowerCase();
  switch (extension) {
    case ".txt":
    case ".md":
    case ".ts":
    case ".tsx":
    case ".js":
    case ".jsx":
    case ".json":
    case ".css":
    case ".html":
    case ".xml":
    case ".yml":
    case ".yaml":
      return "text/plain; charset=utf-8";
    case ".pdf":
      return "application/pdf";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".rtf":
      return "application/rtf";
    case ".zip":
      return "application/zip";
    case ".csv":
      return "text/csv; charset=utf-8";
    case ".tsv":
      return "text/tab-separated-values; charset=utf-8";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    default:
      return "application/octet-stream";
  }
}
