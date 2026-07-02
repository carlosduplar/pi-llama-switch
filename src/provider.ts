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

export function buildProviderModels(
  config: SwitcherConfig
): ProviderModel[] {
  return Object.entries(config.models).map(([key, model]) => ({
    id: key,
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
    id: modelKey,
    name: model.name,
    reasoning: model.tags?.includes("reasoning") ?? false,
    input: model.vision ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
}
