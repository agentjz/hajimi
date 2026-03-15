import os from "node:os";

export function resolveRemoteDisplayHost(options: {
  requestedHost: string;
  listenHost: string;
}): string {
  const requestedHost = options.requestedHost.trim();
  if (requestedHost) {
    return requestedHost;
  }

  if (options.listenHost === "127.0.0.1" || options.listenHost === "::1") {
    return "127.0.0.1";
  }

  return findBestLanAddress() ?? "127.0.0.1";
}

export function findBestLanAddress(): string | null {
  const interfaces = os.networkInterfaces();
  const candidates: string[] = [];

  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses ?? []) {
      if (!address || address.internal || address.family !== "IPv4") {
        continue;
      }

      candidates.push(address.address);
    }
  }

  const privateAddress = candidates.find(isPrivateIpv4Address);
  return privateAddress ?? candidates[0] ?? null;
}

function isPrivateIpv4Address(value: string): boolean {
  if (value.startsWith("10.")) {
    return true;
  }

  if (value.startsWith("192.168.")) {
    return true;
  }

  const match = value.match(/^172\.(\d{1,2})\./);
  if (!match) {
    return false;
  }

  const secondOctet = Number.parseInt(match[1] ?? "", 10);
  return secondOctet >= 16 && secondOctet <= 31;
}
