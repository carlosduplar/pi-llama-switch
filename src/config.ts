import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";

export interface ServerConfig {
  host: string;
  port: number;
  healthTimeout: number;
  portReleaseTimeout: number;
}

export interface ModelConfig {
  name: string;
  description: string;
  command: string[];
  env?: Record<string, string>;
  modelId?: string;
  vision: boolean;
  contextWindow: number;
  maxTokens: number;
  tags: string[];
}

export interface SwitcherConfig {
  server: ServerConfig;
  defaultModel: string;
  models: Record<string, ModelConfig>;
}

const CONFIG_FILENAME = "model-switcher.json";

/**
 * Formats a host for use inside a URL authority. IPv6 literals must be
 * bracketed (http://[::1]:8080), while already-bracketed hosts are left alone.
 */
export function formatHostForUrl(host: string): string {
  if (host.startsWith("[") && host.endsWith("]")) {
    return host;
  }
  if (host.includes(":")) {
    return `[${host}]`;
  }
  return host;
}

export function formatServerUrl(
  host: string,
  port: number,
  path = ""
): string {
  return `http://${formatHostForUrl(host)}:${port}${path}`;
}

/**
 * node:net's socket.connect(port, host) expects an unbracketed IPv6 address.
 */
export function normalizeHostForSocket(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function expandTilde(p: string): string {
  // Handle --arg=~/path pattern
  const eqMatch = p.match(/^(--\w[\w-]*=)(~\/.*)$/);
  if (eqMatch) {
    return eqMatch[1] + join(homedir(), eqMatch[2].slice(2));
  }
  // Handle standalone ~/path
  if (p.startsWith("~/")) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

function expandCommand(command: string[]): string[] {
  return command.map((arg) => expandTilde(arg));
}

function validateConfig(raw: any): SwitcherConfig {
  if (!raw || typeof raw !== "object") {
    throw new Error("Config must be a JSON object");
  }

  if (!raw.server || typeof raw.server !== "object") {
    throw new Error("Config must have a 'server' object");
  }

  if (typeof raw.server.host !== "string") {
    throw new Error("server.host must be a string");
  }

  if (typeof raw.server.port !== "number") {
    throw new Error("server.port must be a number");
  }

  if (!raw.models || typeof raw.models !== "object") {
    throw new Error("Config must have a 'models' object");
  }

  for (const [key, model] of Object.entries(raw.models)) {
    const m = model as any;
    if (!m.name || typeof m.name !== "string") {
      throw new Error(`models.${key}.name must be a string`);
    }
    if (!m.description || typeof m.description !== "string") {
      throw new Error(`models.${key}.description must be a string`);
    }
    if (!Array.isArray(m.command) || m.command.length === 0) {
      throw new Error(`models.${key}.command must be a non-empty array`);
    }
    if (
      m.modelId !== undefined &&
      (typeof m.modelId !== "string" || m.modelId.trim().length === 0)
    ) {
      throw new Error(`models.${key}.modelId must be a non-empty string`);
    }
  }

  const server: ServerConfig = {
    host: raw.server.host,
    port: raw.server.port,
    healthTimeout: raw.server.healthTimeout ?? 60,
    portReleaseTimeout: raw.server.portReleaseTimeout ?? 30,
  };

  const models: Record<string, ModelConfig> = {};
  for (const [key, model] of Object.entries(raw.models) as [string, any][]) {
    models[key] = {
      name: model.name,
      description: model.description,
      command: expandCommand(model.command),
      env: model.env && typeof model.env === "object" ? model.env : undefined,
      modelId: model.modelId?.trim() || undefined,
      vision: model.vision ?? false,
      contextWindow: model.contextWindow ?? 8192,
      maxTokens: model.maxTokens ?? 4096,
      tags: model.tags ?? [],
    };
  }

  if (raw.defaultModel !== undefined && typeof raw.defaultModel !== "string") {
    throw new Error("defaultModel must be a string");
  }
  const requestedDefault =
    typeof raw.defaultModel === "string" ? raw.defaultModel.trim() : "";
  const defaultModel = requestedDefault || Object.keys(models)[0] || "";
  if (defaultModel && !models[defaultModel]) {
    throw new Error(`defaultModel '${defaultModel}' not found in models`);
  }

  return {
    server,
    defaultModel,
    models,
  };
}

export function getConfigPath(): string {
  return join(homedir(), ".pi", "agent", CONFIG_FILENAME);
}

export function loadConfig(configPath?: string): SwitcherConfig | null {
  const path = configPath ?? getConfigPath();

  if (!existsSync(path)) {
    return null;
  }

  const raw = JSON.parse(readFileSync(path, "utf-8"));
  return validateConfig(raw);
}
