import http from "node:http";
import https from "node:https";
import { cyrb53 } from "./hash.ts";

const httpAgent = new http.Agent({ keepAlive: false, maxSockets: Infinity });
const httpsAgent = new https.Agent({ keepAlive: false, maxSockets: Infinity });

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
              resolve(
                urlPath.startsWith("http") ? urlPath : `${baseUrl}${urlPath}`,
              );
            } catch (e) {
              reject(e);
            }
          } else {
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
  return requestRvcSynthesize(rvcHost, text, hash, priority, signal);
}
