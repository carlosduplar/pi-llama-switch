import type { SwitcherConfig, ModelConfig } from "./config.js";

export interface ProviderModel {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}

/**
 * Finds the value of a CLI flag, supporting both `--flag value` and
 * `--flag=value` forms.
 */
export function findFlagValue(args: string[], names: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    for (const name of names) {
      if (arg === name) {
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith("-")) {
          return next;
        }
      }
      const prefix = `${name}=`;
      if (arg.startsWith(prefix)) {
        const value = arg.slice(prefix.length);
        if (value.length > 0) {
          return value;
        }
      }
    }
  }
  return undefined;
}

function isVllmCommand(command: string[]): boolean {
  if (command.some((arg) => arg.includes("vllm.entrypoints.openai.api_server"))) {
    return true;
  }
  const serveIndex = command.indexOf("serve");
  if (serveIndex === -1) return false;
  return command
    .slice(0, serveIndex)
    .some((arg) => arg === "vllm" || arg.replace(/\\/g, "/").endsWith("/vllm"));
}

function vllmModelId(command: string[]): string | undefined {
  const flagValue = findFlagValue(command, ["--model"]);
  if (flagValue) return flagValue;

  const serveIndex = command.indexOf("serve");
  if (serveIndex === -1) return undefined;
  const positional = command[serveIndex + 1];
  if (positional && !positional.startsWith("-")) {
    return positional;
  }
  return undefined;
}

/**
 * Resolves the model ID sent in OpenAI API requests. Backends may serve a
 * different ID than the config key: llama-server uses `--alias`, vLLM uses
 * `--served-model-name`, and both accept an explicit `modelId` override.
 */
export function resolveApiModelId(key: string, model: ModelConfig): string {
  if (model.modelId) {
    return model.modelId;
  }

  const servedName = findFlagValue(model.command, ["--served-model-name"]);
  if (servedName) return servedName;

  const alias = findFlagValue(model.command, ["--alias", "-a"]);
  if (alias) return alias;

  if (isVllmCommand(model.command)) {
    const modelId = vllmModelId(model.command);
    if (modelId) return modelId;
  }

  return key;
}

export function buildProviderModels(
  config: SwitcherConfig
): ProviderModel[] {
  return Object.entries(config.models).map(([key, model]) => ({
    id: resolveApiModelId(key, model),
    name: model.name,
    reasoning: model.tags?.includes("reasoning") ?? false,
    input: model.vision ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  }));
}

export function getModelForProvider(
  config: SwitcherConfig,
  modelKey: string
): ProviderModel | null {
  const model = config.models[modelKey];
  if (!model) return null;

  return {
    id: resolveApiModelId(modelKey, model),
    name: model.name,
    reasoning: model.tags?.includes("reasoning") ?? false,
    input: model.vision ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
}
