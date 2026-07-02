import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { waitForHealth } from "./health.js";
import type { SwitcherConfig, ModelConfig, ServerConfig } from "./config.js";

const PID_FILENAME = "llama-switch.pid";
const LOG_FILENAME = "llama-switch.log";

export interface SwitcherState {
  activeModelKey: string | null;
  activePid: number | null;
  isSwitching: boolean;
}

const state: SwitcherState = {
  activeModelKey: null,
  activePid: null,
  isSwitching: false,
};

export function getState(): Readonly<SwitcherState> {
  return state;
}

function getPidPath(): string {
  return join(homedir(), ".pi", "agent", PID_FILENAME);
}

function getLogPath(): string {
  return join(homedir(), ".pi", "agent", LOG_FILENAME);
}

export function readPidFile(): number | null {
  const path = getPidPath();
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf-8").trim();
  const pid = parseInt(raw, 10);
  return isNaN(pid) ? null : pid;
}

export function writePidFile(pid: number): void {
  writeFileSync(getPidPath(), String(pid), "utf-8");
}

export function deletePidFile(): void {
  const path = getPidPath();
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isLlamaServer(pid: number): boolean {
  try {
    const { execSync } = require("node:child_process");
    const comm = execSync(`ps -p ${pid} -o comm=`, { encoding: "utf-8" }).trim();
    return comm.includes("llama-server");
  } catch {
    return false;
  }
}

export function findLlamaServerPid(port: number): number | null {
  try {
    const { execSync } = require("node:child_process");
    const output = execSync("pgrep -af llama-server", { encoding: "utf-8", timeout: 3000 }).trim();
    if (!output) return null;
    for (const line of output.split("\n")) {
      const match = line.match(/^(\d+)\s/);
      if (!match) continue;
      const pid = parseInt(match[1], 10);
      if (isNaN(pid)) continue;
      if (line.includes(`--port`) && line.includes(String(port))) {
        return pid;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export async function stopServer(
  serverConfig: ServerConfig,
  gracefulTimeout = 10000
): Promise<void> {
  let pid = state.activePid;

  if (!pid || !isProcessAlive(pid)) {
    pid = findLlamaServerPid(serverConfig.port);
    if (pid) {
      state.activePid = pid;
      writePidFile(pid);
    }
  }

  if (pid && isProcessAlive(pid)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process already dead
    }

    const deadline = Date.now() + gracefulTimeout;
    while (Date.now() < deadline && isProcessAlive(pid)) {
      await new Promise((r) => setTimeout(r, 200));
    }

    if (isProcessAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already dead
      }
      // Give OS time to reclaim socket after SIGKILL
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  // Wait for port release
  await waitForPortRelease(
    serverConfig.host,
    serverConfig.port,
    serverConfig.portReleaseTimeout
  );
}

async function waitForPortRelease(
  host: string,
  port: number,
  timeout: number
): Promise<void> {
  const net = await import("node:net");
  const deadline = Date.now() + timeout * 1000;

  while (Date.now() < deadline) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(1000);
      socket.on("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.on("timeout", () => {
        socket.destroy();
        resolve(false);
      });
      socket.on("error", () => {
        resolve(false);
      });
      socket.connect(port, host);
    });

    if (!connected) return;

    await new Promise((r) => setTimeout(r, 500));
  }

  throw new Error(
    `Port ${port} is still in use after ${timeout}s. Try: lsof -ti:${port}`
  );
}

export interface SwitchProgressCallback {
  onStatusUpdate?: (message: string) => void;
  onHealthProgress?: (elapsed: number, status: { status: string; error?: string }) => void;
}

export async function switchModel(
  config: SwitcherConfig,
  modelKey: string,
  progress?: SwitchProgressCallback,
  signal?: AbortSignal
): Promise<void> {
  const model = config.models[modelKey];
  if (!model) {
    throw new Error(
      `Model '${modelKey}' not found. Available: ${Object.keys(config.models).join(", ")}`
    );
  }

  if (state.isSwitching) {
    throw new Error("Switch already in progress");
  }

  state.isSwitching = true;

  try {
    progress?.onStatusUpdate?.(`Stopping current server...`);
    await stopServer(config.server);

    progress?.onStatusUpdate?.(`Starting ${model.name}...`);
    const child = spawn(model.command[0], model.command.slice(1), {
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, ...(model.env ?? {}) },
    });

    if (!child.pid) {
      throw new Error("Failed to start llama-server: no PID returned");
    }

    // Capture stderr to log file
    const logPath = getLogPath();
    const logStream = require("node:fs").createWriteStream(logPath, { flags: "w" });
    child.stderr?.pipe(logStream);

    state.activePid = child.pid;
    writePidFile(child.pid);

    child.on("error", (err) => {
      console.error(`llama-server process error: ${err.message}`);
      state.activeModelKey = null;
      state.activePid = null;
      deletePidFile();
    });

    child.on("exit", (code) => {
      if (code !== null && code !== 0) {
        console.error(`llama-server exited with code ${code}`);
      }
      if (state.activePid === child.pid) {
        state.activeModelKey = null;
        state.activePid = null;
        deletePidFile();
      }
    });

    progress?.onStatusUpdate?.(`Waiting for ${model.name} to be ready...`);
    await waitForHealth(
      config.server,
      (elapsed, status) => {
        progress?.onHealthProgress?.(elapsed, {
          status: status.status,
          error: status.error,
        });
        progress?.onStatusUpdate?.(
          `Loading ${model.name}... ${elapsed}s (${status.status})`
        );
      },
      signal
    );

    state.activeModelKey = modelKey;
    progress?.onStatusUpdate?.(`Switched to ${model.name}`);
  } catch (err) {
    state.activeModelKey = null;
    state.activePid = null;
    deletePidFile();
    throw err;
  } finally {
    state.isSwitching = false;
  }
}

export function disconnectState(): void {
  state.activeModelKey = null;
  state.activePid = null;
  state.isSwitching = false;
}
