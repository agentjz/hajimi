import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";

export interface RemoteAuth {
  authorize(request: IncomingMessage): boolean;
}

export function createRemoteTokenAuth(token: string): RemoteAuth {
  const expected = Buffer.from(token, "utf8");

  return {
    authorize(request): boolean {
      const supplied = readAuthToken(request);
      if (!supplied) {
        return false;
      }

      const actual = Buffer.from(supplied, "utf8");
      return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    },
  };
}

function readAuthToken(request: IncomingMessage): string {
  const header = request.headers.authorization;
  if (typeof header === "string") {
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  const legacy = request.headers["x-hajimi-token"];
  return typeof legacy === "string" ? legacy.trim() : "";
}
