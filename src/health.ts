import { formatServerUrl, type ServerConfig } from "./config.js";

export interface HealthStatus {
  status: "ok" | "loading" | "error" | "unknown";
  error?: string;
}

// Cap a single health attempt so a stalled server cannot consume the whole timeout.
const MAX_ATTEMPT_TIMEOUT_MS = 5000;

async function fetchHealth(
  host: string,
  port: number,
  signal?: AbortSignal
): Promise<HealthStatus> {
  try {
    const res = await fetch(formatServerUrl(host, port, "/health"), {
      signal,
      headers: { Accept: "application/json" },
    });

    // 503 means server is alive but still loading (llama-server) or unhealthy (vLLM)
    if (res.status === 503) {
      return { status: "loading", error: "server returned 503" };
    }

    if (!res.ok) {
      return { status: "unknown", error: `HTTP ${res.status}` };
    }

    // Try parsing JSON body (llama.cpp returns { status: "ok" })
    // vLLM returns 200 with empty body — treat as healthy
    const text = await res.text();
    if (!text) {
      return { status: "ok" };
    }

    const data = JSON.parse(text);
    const s = data?.status;

    if (s === "ok") return { status: "ok" };
    if (s === "error") return { status: "error", error: "server reported error" };
    if (typeof s === "string" && s.includes("loading")) {
      return { status: "loading" };
    }

    return { status: s ?? "unknown" };
  } catch (err: any) {
    if (err.name === "TimeoutError") {
      return { status: "unknown", error: "request timed out" };
    }
    if (err.name === "AbortError") {
      return { status: "unknown", error: "aborted" };
    }
    return { status: "unknown", error: err.message ?? String(err) };
  }
}

export type HealthProgressCallback = (
  elapsed: number,
  lastStatus: HealthStatus
) => void;

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Health check aborted"));
      return;
    }

    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Health check aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function waitForHealth(
  server: ServerConfig,
  onProgress?: HealthProgressCallback,
  signal?: AbortSignal
): Promise<HealthStatus> {
  const { host, port, healthTimeout } = server;
  const startTime = Date.now();
  const deadline = startTime + healthTimeout * 1000;
  let lastStatus: HealthStatus = { status: "unknown" };

  while (true) {
    if (signal?.aborted) {
      throw new Error("Health check aborted");
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;

    const attemptTimeout = AbortSignal.timeout(
      Math.min(remainingMs, MAX_ATTEMPT_TIMEOUT_MS)
    );
    const requestSignal = signal
      ? AbortSignal.any([signal, attemptTimeout])
      : attemptTimeout;

    lastStatus = await fetchHealth(host, port, requestSignal);

    if (signal?.aborted) {
      throw new Error("Health check aborted");
    }

    if (lastStatus.status === "ok") {
      return lastStatus;
    }

    if (lastStatus.status === "error") {
      throw new Error(
        `Server reported error status: ${lastStatus.error ?? "unknown"}`
      );
    }

    onProgress?.(Math.floor((Date.now() - startTime) / 1000), lastStatus);

    const sleepMs = Math.min(1000, Math.max(0, deadline - Date.now()));
    if (sleepMs > 0) {
      await abortableSleep(sleepMs, signal);
    }
  }

  throw new Error(
    `Health check timed out after ${healthTimeout}s. Last status: ${lastStatus.status} (${lastStatus.error ?? "no error"})`
  );
}

export async function checkHealth(
  host: string,
  port: number,
  timeoutMs = 5000
): Promise<boolean> {
  const status = await fetchHealth(host, port, AbortSignal.timeout(timeoutMs));
  return status.status === "ok";
}
