import { spawn, execSync, type ChildProcess } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  unlinkSync,
  openSync,
  closeSync,
  mkdirSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { waitForHealth } from "./health.js";
import {
  normalizeHostForSocket,
  type SwitcherConfig,
  type ModelConfig,
  type ServerConfig,
} from "./config.js";

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

export function updateActiveState(modelKey: string, pid: number): void {
  state.activeModelKey = modelKey;
  state.activePid = pid;
  writePidFile(pid);
}

/**
 * Clears the active model key without touching the running process. Used when
 * the config reload drops the active model but its server is still up.
 */
export function clearActiveModelKey(): void {
  state.activeModelKey = null;
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
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}

/**
 * Boundary-safe check for a token inside a process command line. Matches whole
 * arguments only, so "8080" does not match "18080" and "python3" matches
 * "/usr/bin/python3".
 */
export function commandLineHasToken(commandLine: string, token: string): boolean {
  if (!token) return false;
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `(?:^|[\\s"'\`=/\\\\])${escaped}(?=$|[\\s"'\`/\\\\])`
  );
  return re.test(commandLine);
}

/**
 * Returns true when the command line contains an explicit `--port` whose last
 * value equals `port`. `-p` is deliberately ignored: in llama-server it is
 * `--prompt`, not the port.
 */
export function hasPortArg(commandLine: string, port: number): boolean {
  const re = /(?:^|\s)--port(?:=|\s+)(\d+)(?=\s|$)/g;
  let last: string | null = null;
  for (const match of commandLine.matchAll(re)) {
    last = match[1];
  }
  return last !== null && Number(last) === port;
}

const GENERIC_EXECUTABLES =
  /^(?:python(?:\d+(?:\.\d+)*)?(?:\.exe)?|node(?:\.exe)?|uv|uvx|bash|sh|zsh|env)$/i;

function matchesConfiguredCommand(commandLine: string, command: string[]): boolean {
  if (command.length === 0) return false;

  const executable = basename(command[0]);
  if (!commandLineHasToken(commandLine, executable)) return false;

  if (!GENERIC_EXECUTABLES.test(executable)) {
    return true;
  }

  // Generic interpreters (python3, node, ...) need a module/script argument to
  // identify the server; matching the interpreter alone would be a false positive.
  const second = command[1];
  if (!second) return false;
  const identifying = second === "-m" ? command[2] : second;
  if (!identifying || identifying.startsWith("-")) return false;
  return commandLineHasToken(commandLine, basename(identifying));
}

/**
 * Returns true when the command line looks like a managed local LLM server:
 * llama-server, a vLLM OpenAI server, or one of the configured commands.
 */
export function isManagedServerCommand(
  cmdLine: string,
  config?: SwitcherConfig
): boolean {
  if (!cmdLine.trim()) return false;
  if (/\bllama-server\b/.test(cmdLine)) return true;
  if (/\bvllm\.entrypoints\.openai\.api_server\b/.test(cmdLine)) return true;
  if (/\bvllm(?:\s+|$).*?\bserve\b/.test(cmdLine)) return true;

  if (config) {
    for (const model of Object.values(config.models)) {
      if (matchesConfiguredCommand(cmdLine, model.command)) {
        return true;
      }
    }
  }

  return false;
}

export function isManagedServer(pid: number, config?: SwitcherConfig): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    const args = execSync(`ps -p ${pid} -o args=`, {
      encoding: "utf-8",
      timeout: 3000,
    }).trim();
    return isManagedServerCommand(args, config);
  } catch {
    return false;
  }
}

/** @deprecated Use isManagedServer instead. */
export function isLlamaServer(pid: number): boolean {
  return isManagedServer(pid);
}

/**
 * Finds a managed server PID listening on `port`. Scans full command lines so
 * both llama-server and `python3 -m vllm...` processes are discovered.
 */
export function findServerPid(
  port: number,
  config?: SwitcherConfig
): number | null {
  try {
    const output = execSync("ps -eo pid=,args=", {
      encoding: "utf-8",
      timeout: 3000,
    });

    for (const line of output.split("\n")) {
      const match = line.match(/^\s*(\d+)\s+(.*)$/);
      if (!match) continue;

      const pid = parseInt(match[1], 10);
      if (isNaN(pid) || pid === process.pid) continue;

      const args = match[2];
      if (isManagedServerCommand(args, config) && hasPortArg(args, port)) {
        return pid;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Sends a signal to a detached child's process group where possible, falling
 * back to the single process so vLLM worker children are also terminated.
 */
function killProcessTree(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Process already dead
    }
  }
}

export async function stopServer(
  serverConfig: ServerConfig,
  config?: SwitcherConfig,
  gracefulTimeout = 10000
): Promise<void> {
  let pid = state.activePid;

  if (!pid || !isProcessAlive(pid) || !isManagedServer(pid, config)) {
    pid = findServerPid(serverConfig.port, config);
    if (pid) {
      state.activePid = pid;
      writePidFile(pid);
    }
  }

  if (pid && isProcessAlive(pid) && isManagedServer(pid, config)) {
    killProcessTree(pid, "SIGTERM");

    const deadline = Date.now() + gracefulTimeout;
    while (Date.now() < deadline && isProcessAlive(pid)) {
      await new Promise((r) => setTimeout(r, 200));
    }

    if (isProcessAlive(pid)) {
      killProcessTree(pid, "SIGKILL");
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
  const socketHost = normalizeHostForSocket(host);

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
      socket.connect(port, socketHost);
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

function waitForSpawn(child: ChildProcess, command: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onSpawn = () => {
      cleanup();
      resolve();
    };
    const onError = (err: Error) => {
      cleanup();
      reject(new Error(`Failed to start ${command}: ${err.message}`));
    };
    const cleanup = () => {
      child.off("spawn", onSpawn);
      child.off("error", onError);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

export async function switchModel(
  config: SwitcherConfig,
  modelKey: string,
  progress?: SwitchProgressCallback,
  signal?: AbortSignal
): Promise<void> {
  const serverSnapshot: ServerConfig = { ...config.server };
  const loadedModel = config.models[modelKey];
  if (!loadedModel) {
    throw new Error(
      `Model '${modelKey}' not found. Available: ${Object.keys(config.models).join(", ")}`
    );
  }
  const modelSnapshot: ModelConfig = {
    ...loadedModel,
    command: [...loadedModel.command],
    env: loadedModel.env ? { ...loadedModel.env } : undefined,
  };

  if (state.isSwitching) {
    throw new Error("Switch already in progress");
  }

  state.isSwitching = true;
  const childAbort = new AbortController();
  let child: ChildProcess | null = null;

  try {
    progress?.onStatusUpdate?.(`Stopping current server...`);
    await stopServer(serverSnapshot, config);

    progress?.onStatusUpdate?.(`Starting ${modelSnapshot.name}...`);
    const logPath = getLogPath();
    mkdirSync(dirname(logPath), { recursive: true });
    const logFd = openSync(logPath, "w");
    try {
      child = spawn(modelSnapshot.command[0], modelSnapshot.command.slice(1), {
        detached: true,
        stdio: ["ignore", "ignore", logFd],
        env: { ...process.env, ...(modelSnapshot.env ?? {}) },
      });
    } finally {
      // The child holds its own duplicate of the descriptor.
      closeSync(logFd);
    }

    // Attach listeners before awaiting spawn so an ENOENT/EACCES 'error' event
    // is always handled and can never crash the host process.
    child.on("error", (err) => {
      console.error(`llama-server process error: ${err.message}`);
      childAbort.abort();
      state.activeModelKey = null;
      state.activePid = null;
      deletePidFile();
    });

    child.on("exit", (code) => {
      if (code !== null && code !== 0) {
        console.error(`llama-server exited with code ${code}`);
      }
      childAbort.abort();
      if (child && state.activePid === child.pid) {
        state.activeModelKey = null;
        state.activePid = null;
        deletePidFile();
      }
    });

    await waitForSpawn(child, modelSnapshot.command[0]);

    if (!child.pid) {
      throw new Error(
        `Failed to start ${modelSnapshot.command[0]}: no PID returned`
      );
    }

    child.unref();

    state.activePid = child.pid;
    writePidFile(child.pid);

    const combinedSignal = signal
      ? AbortSignal.any([signal, childAbort.signal])
      : childAbort.signal;

    progress?.onStatusUpdate?.(`Waiting for ${modelSnapshot.name} to be ready...`);
    await waitForHealth(
      serverSnapshot,
      (elapsed, status) => {
        progress?.onHealthProgress?.(elapsed, {
          status: status.status,
          error: status.error,
        });
        progress?.onStatusUpdate?.(
          `Loading ${modelSnapshot.name}... ${elapsed}s (${status.status})`
        );
      },
      combinedSignal
    );

    state.activeModelKey = modelKey;
    progress?.onStatusUpdate?.(`Switched to ${modelSnapshot.name}`);
  } catch (err) {
    if (child?.pid) {
      killProcessTree(child.pid, "SIGKILL");
    }
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
