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

function expandTilde(p: string): string {
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
  }

  const server: ServerConfig = {
    host: raw.server.host,
    port: raw.server.port,
    healthTimeout: raw.server.healthTimeout ?? 60,
    portReleaseTimeout: raw.server.portReleaseTimeout ?? 15,
  };

  const models: Record<string, ModelConfig> = {};
  for (const [key, model] of Object.entries(raw.models) as [string, any][]) {
    models[key] = {
      name: model.name,
      description: model.description,
      command: expandCommand(model.command),
      env: model.env && typeof model.env === "object" ? model.env : undefined,
      vision: model.vision ?? false,
      contextWindow: model.contextWindow ?? 8192,
      maxTokens: model.maxTokens ?? 4096,
      tags: model.tags ?? [],
    };
  }

  return {
    server,
    defaultModel: raw.defaultModel ?? Object.keys(models)[0] ?? "",
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
