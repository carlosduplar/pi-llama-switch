import type { ServerConfig } from "./config.js";

export interface HealthStatus {
  status: "ok" | "loading" | "error" | "unknown";
  error?: string;
}

async function fetchHealth(
  host: string,
  port: number,
  signal?: AbortSignal
): Promise<HealthStatus> {
  try {
    const res = await fetch(`http://${host}:${port}/health`, {
      signal,
      headers: { Accept: "application/json" },
    });

    // 503 means server is alive but unhealthy (vLLM engine dead)
    if (res.status === 503) {
      return { status: "error", error: "server returned 503" };
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

export async function waitForHealth(
  server: ServerConfig,
  onProgress?: HealthProgressCallback,
  signal?: AbortSignal
): Promise<HealthStatus> {
  const { host, port, healthTimeout } = server;
  const deadline = Date.now() + healthTimeout * 1000;
  let lastStatus: HealthStatus = { status: "unknown" };

  while (Date.now() < deadline) {
    if (signal?.aborted) {
      throw new Error("Health check aborted");
    }

    lastStatus = await fetchHealth(host, port, signal);

    if (lastStatus.status === "ok") {
      return lastStatus;
    }

    if (lastStatus.status === "error") {
      throw new Error(
        `Server reported error status: ${lastStatus.error ?? "unknown"}`
      );
    }

    onProgress?.(Math.floor((Date.now() - (deadline - healthTimeout * 1000)) / 1000), lastStatus);

    await new Promise((r) => setTimeout(r, 1000));
  }

  throw new Error(
    `Health check timed out after ${healthTimeout}s. Last status: ${lastStatus.status} (${lastStatus.error ?? "no error"})`
  );
}

export async function checkHealth(
  host: string,
  port: number
): Promise<boolean> {
  const status = await fetchHealth(host, port);
  return status.status === "ok";
}
