import http from "node:http";
import https from "node:https";
import { cyrb53 } from "./hash.ts";

const MAX_CONCURRENT_RVC_REQUESTS = 8;

const httpAgent = new http.Agent({
  keepAlive: false,
  maxSockets: MAX_CONCURRENT_RVC_REQUESTS,
});
const httpsAgent = new https.Agent({
  keepAlive: false,
  maxSockets: MAX_CONCURRENT_RVC_REQUESTS,
});

let activeRequests = 0;
const waitQueue: Array<() => void> = [];

function acquireSlot(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new Error("Aborted"));
  }
  if (activeRequests < MAX_CONCURRENT_RVC_REQUESTS) {
    activeRequests++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      const idx = waitQueue.indexOf(grant);
      if (idx !== -1) {
        waitQueue.splice(idx, 1);
      }
      reject(new Error("Aborted"));
    };
    const grant = () => {
      signal?.removeEventListener("abort", onAbort);
      activeRequests++;
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    waitQueue.push(grant);
  });
}

function releaseSlot(): void {
  activeRequests--;
  const next = waitQueue.shift();
  if (next) {
    next();
  }
}

export function normalizeClueText(text: string): string {
  return text.replace(/^\(.*\)/, "").replace(/_+/g, " blank ").trim();
}

function requestRvcSynthesize(
  rvcHost: string,
  text: string,
  hash: string,
  priority: boolean,
  signal?: AbortSignal,
): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted"));
      return;
    }

    const baseUrl = rvcHost.replace(/\/+$/, "");
    const targetUrl = new URL(`${baseUrl}/synthesize`);
    const isHttps = targetUrl.protocol === "https:";
    const payload = Buffer.from(
      JSON.stringify({ text, hash, priority }),
      "utf-8",
    );

    const req = (isHttps ? https : http).request(
      targetUrl,
      {
        method: "POST",
        agent: isHttps ? httpsAgent : httpAgent,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": payload.length,
        },
        timeout: 0,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const bodyStr = Buffer.concat(chunks).toString("utf-8");
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const data = JSON.parse(bodyStr);
              const urlPath =
                typeof data.url === "string" ? data.url : `/audio/${hash}.mp3`;
              const resultUrl = urlPath.startsWith("http")
                ? urlPath
                : `${baseUrl}${urlPath}`;
              console.log("[RVC] synthesized", {
                hash,
                status: res.statusCode,
                url: resultUrl,
              });
              resolve(resultUrl);
            } catch (e) {
              console.log("[RVC] invalid JSON response", {
                hash,
                status: res.statusCode,
                body: bodyStr,
              });
              reject(e);
            }
          } else {
            console.log("[RVC] HTTP error", {
              hash,
              status: res.statusCode,
              body: bodyStr,
            });
            reject(
              new Error(`RVC service HTTP ${res.statusCode}: ${bodyStr}`),
            );
          }
        });
      },
    );

    const onAbort = () => {
      req.destroy(new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    req.on("error", (err) => {
      signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    req.on("close", () => {
      signal?.removeEventListener("abort", onAbort);
    });

    req.write(payload);
    req.end();
  });
}

// Given input text, triggers synthesis on the Python RVC server and returns the remote MP3 URL
export async function genAITextToSpeech(
  rvcHost: string,
  text: string,
  priority = false,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (
    !rvcHost ||
    !text ||
    text.length > 10000 ||
    text.startsWith("!") ||
    text.startsWith("http")
  ) {
    return;
  }
  const hash = cyrb53(text).toString();
  await acquireSlot(signal);
  try {
    return await requestRvcSynthesize(rvcHost, text, hash, priority, signal);
  } finally {
    releaseSlot();
  }
}
