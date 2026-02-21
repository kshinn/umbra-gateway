/**
 * gatewayFetch.ts — fetch that routes .onion URLs through Tor SOCKS5.
 *
 * When the gateway URL is a Tor hidden service (*.onion), we send the request
 * via socks5h://127.0.0.1:9050 (system Tor). Otherwise we use global fetch.
 * Facilitator and other clearnet URLs are unchanged.
 */

import http from "node:http";
import https from "node:https";
import { SocksProxyAgent } from "socks-proxy-agent";

let _socksPort = 9050

/** Update the SOCKS port used for .onion requests (called after arti bootstraps). */
export function setSocksPort(port: number): void {
  _socksPort = port
}

const SOCKS_URL = (): string => `socks5h://127.0.0.1:${_socksPort}`

function isOnionUrl(url: string): boolean {
  try {
    return new URL(url).hostname.endsWith(".onion");
  } catch {
    return false;
  }
}

function requestViaSocks(url: string, init?: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const isHttps = u.protocol === "https:";
    const agent = new SocksProxyAgent(SOCKS_URL());
    const body =
      init?.body === undefined
        ? undefined
        : typeof init.body === "string"
          ? init.body
          : ((init.body as Buffer)?.toString?.() ?? String(init.body));

    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers as Record<string, string>;
      for (const [k, v] of Object.entries(h))
        if (v !== undefined) headers[k] = String(v);
    }

    const opts = {
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      method: init?.method ?? "GET",
      headers,
      agent,
    };

    const mod = isHttps ? https : http;
    const req = mod.request(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks);
        resolve(
          new Response(body, {
            status: res.statusCode ?? 0,
            statusText: res.statusMessage ?? "",
            headers: new Headers(res.headers as Record<string, string>),
          }),
        );
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/**
 * Fetch the given URL. If the host is *.onion, the request is sent through
 * Tor SOCKS5 on the configured port (see setSocksPort). Otherwise uses global fetch.
 */
export async function gatewayFetch(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  if (isOnionUrl(url)) {
    return requestViaSocks(url, init);
  }
  return fetch(url, init);
}
