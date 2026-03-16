import type { RemoteConfig } from "../types.js";

export type RemoteExposureKind = "loopback" | "lan" | "custom";

export interface ResolvedRemoteConfig extends RemoteConfig {
  listenHost: string;
  displayHost: string;
  exposureKind: RemoteExposureKind;
}

const DEFAULT_REMOTE_PORT = 4387;

export function getDefaultRemoteConfig(): RemoteConfig {
  return {
    enabled: true,
    host: "",
    port: DEFAULT_REMOTE_PORT,
    bind: "lan",
    publicUrl: "",
  };
}

export function normalizeRemoteConfig(config: Partial<RemoteConfig> | undefined): RemoteConfig {
  return {
    enabled: config?.enabled !== false,
    host: String(config?.host ?? "").trim(),
    port: clampNumber(config?.port, 0, 65_535, DEFAULT_REMOTE_PORT),
    bind: normalizeBind(config?.bind),
    publicUrl: String(config?.publicUrl ?? "").trim(),
  };
}

export function resolveRemoteListenHost(bind: string): {
  listenHost: string;
  exposureKind: RemoteExposureKind;
} {
  const normalized = normalizeBind(bind);
  if (normalized === "loopback") {
    return {
      listenHost: "127.0.0.1",
      exposureKind: "loopback",
    };
  }

  if (normalized === "lan" || normalized === "all") {
    return {
      listenHost: "0.0.0.0",
      exposureKind: "lan",
    };
  }

  return {
    listenHost: normalized,
    exposureKind: "custom",
  };
}

function normalizeBind(value: string | undefined): string {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) {
    return "lan";
  }

  if (normalized === "0.0.0.0" || normalized === "::" || normalized === "all") {
    return "all";
  }

  if (normalized === "127.0.0.1" || normalized === "::1" || normalized === "loopback" || normalized === "local") {
    return "loopback";
  }

  if (normalized === "lan") {
    return "lan";
  }

  return String(value ?? "").trim();
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, Math.trunc(value)));
}
