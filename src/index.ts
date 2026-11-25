import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import {
  formatServerUrl,
  loadConfig,
  type SwitcherConfig,
} from "./config.js";
import {
  getState,
  readPidFile,
  writePidFile,
  isProcessAlive,
  isManagedServer,
  findServerPid,
  switchModel,
  disconnectState,
  deletePidFile,
  updateActiveState,
  clearActiveModelKey,
  commandLineHasToken,
} from "./switcher.js";
import { checkHealth } from "./health.js";
import {
  buildProviderModels,
  findFlagValue,
  resolveApiModelId,
} from "./provider.js";

const PROVIDER_ID = "llama-local";

const SECONDARY_MODEL_FLAGS = [
  "--mmproj",
  "--mmproj-url",
  "--lora",
  "--lora-scaled",
  "--draft",
  "-md",
  "--model-draft",
  "--control-vector",
];

const DISTINGUISHING_FLAGS = [
  "--mmproj",
  "--ctx-size",
  "--max-model-len",
  "--alias",
  "--served-model-name",
];

export default async function (pi: ExtensionAPI) {
  const loadedConfig = loadConfig();

  if (!loadedConfig) {
    console.warn(
      "[pi-llama-switch] No config found at ~/.pi/agent/model-switcher.json"
    );
    return;
  }

  let config: SwitcherConfig = loadedConfig;

  // Register provider from default model
  registerProvider(pi, config, config.defaultModel);

  // Register /switch command
  pi.registerCommand("switch", {
    description: "Switch to a different local LLM model",
    handler: async (args, ctx) => {
      const subcommand = args?.trim();

      if (!subcommand) {
        return await handleInteractiveSwitch(pi, config, ctx);
      }

      if (subcommand === "list") {
        return handleList(config, ctx);
      }

      if (subcommand === "status") {
        return handleStatus(config, ctx);
      }

      if (subcommand === "reload") {
        return await handleReload(pi, ctx, (next) => {
          config = next;
        });
      }

      if (subcommand === "logs") {
        return handleLogs(ctx);
      }

      if (subcommand === "--help" || subcommand === "-h") {
        ctx.ui.notify(
          "Usage: /switch [model_key|list|status|reload|logs]",
          "info"
        );
        return;
      }

      // Direct switch to model key
      if (config.models[subcommand]) {
        return await handleDirectSwitch(pi, config, subcommand, ctx);
      }

      ctx.ui.notify(
        `Unknown model or subcommand: '${subcommand}'. Available: ${Object.keys(config.models).join(", ")}`,
        "error"
      );
    },
  });

  // Register model_switch tool
  pi.registerTool({
    name: "model_switch",
    label: "Switch Model",
    description:
      "Switch to a different local LLM model. Each model requires different server flags.",
    promptSnippet: "Switch between local LLM models with different capabilities",
    promptGuidelines: [
      "Use model_switch when the user explicitly asks to switch models or needs a capability (vision, audio, reasoning) not supported by the current model.",
      "model_switch stops the current llama-server and restarts with a new configuration. This takes 10-60 seconds depending on model size.",
    ],
    parameters: Type.Object({
      model: Type.String({
        description: "Model key from the config (e.g. 'qwen', 'ornith', 'gemma4b')",
      }),
      dryRun: Type.Optional(
        Type.Boolean({
          description:
            "If true, print the command that would be run without executing it",
        })
      ),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const snapshot = config;
      const modelKey = params.model;
      const dryRun = params.dryRun ?? false;
      const model = snapshot.models[modelKey];

      if (!model) {
        const available = Object.keys(snapshot.models).join(", ");
        return {
          content: [
            {
              type: "text",
              text: `Model '${modelKey}' not found. Available: ${available}`,
            },
          ],
          details: { error: "model_not_found", available: Object.keys(snapshot.models) },
        };
      }

      if (dryRun) {
        return {
          content: [
            {
              type: "text",
              text: `Dry run: would execute:\n${model.command.join(" ")}`,
            },
          ],
          details: { dryRun: true, command: model.command },
        } as any;
      }

      onUpdate?.({
        content: [{ type: "text", text: `Switching to ${model.name}...` }],
        details: { phase: "switching", model: modelKey },
      });

      try {
        await switchModel(snapshot, modelKey, {
          onStatusUpdate: (msg) => {
            onUpdate?.({ content: [{ type: "text", text: msg }], details: { phase: "switching", model: modelKey } });
          },
        }, signal);

        const selected = await activateModel(pi, snapshot, modelKey, ctx);
        const selectionNote = selected
          ? ""
          : "\nThe server switched and the provider was updated. If Pi did not select the new model automatically, choose it via /model.";

        return {
          content: [
            {
              type: "text",
              text: `Switched to ${model.name} (${model.description}). Context window: ${model.contextWindow} tokens.${selectionNote}`,
            },
          ],
          details: {
            switched: true,
            model: modelKey,
            name: model.name,
            contextWindow: model.contextWindow,
            selectedModel: selected,
          },
        } as any;
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to switch to '${modelKey}': ${err.message}\nCheck logs: ~/.pi/agent/llama-switch.log`,
            },
          ],
          details: { error: err.message },
          isError: true,
        } as any;
      }
    },
  });

  // session_start: reconnect to existing server
  pi.on("session_start", async (_event, ctx) => {
    let pid = readPidFile();
    if (!pid || !isProcessAlive(pid) || !isManagedServer(pid, config)) {
      pid = findServerPid(config.server.port, config);
      if (pid) {
        writePidFile(pid);
      }
    }
    if (pid && isProcessAlive(pid) && isManagedServer(pid, config)) {
      const alive = await checkHealth(config.server.host, config.server.port);
      if (alive) {
        const modelKey = detectModelFromPid(config, pid) ?? config.defaultModel;
        updateActiveState(modelKey, pid);
        await activateModel(pi, config, modelKey, ctx);
        return;
      }
    }

    deletePidFile();
    ctx.ui.setStatus("llama-switch", "no model loaded");
  });

  // session_shutdown: clean up in-memory state
  pi.on("session_shutdown", async (event) => {
    if (event.reason === "reload") return;
    disconnectState();
  });

  // before_agent_start: inject model identity
  pi.on("before_agent_start", async (event, _ctx) => {
    const state = getState();
    if (state.activeModelKey) {
      const model = config.models[state.activeModelKey];
      if (model) {
        return {
          systemPrompt:
            event.systemPrompt +
            `\n\nCurrent LLM: ${model.name} (${model.description}). Context window: ${model.contextWindow} tokens.`,
        };
      }
    }
  });
}

function registerProvider(
  pi: ExtensionAPI,
  config: SwitcherConfig,
  modelKey: string
): void {
  const targetModel = config.models[modelKey];
  if (!targetModel) return;

  const models = buildProviderModels(config);
  const activeApiId = resolveApiModelId(modelKey, targetModel);
  const activeModel = models.find((m) => m.id === activeApiId);
  if (!activeModel) return;

  pi.registerProvider(PROVIDER_ID, {
    baseUrl: formatServerUrl(config.server.host, config.server.port, "/v1"),
    apiKey: "no-key",
    api: "openai-completions",
    models,
  });
}

export async function activateModel(
  pi: ExtensionAPI,
  config: SwitcherConfig,
  modelKey: string,
  ctx?: any
): Promise<boolean> {
  registerProvider(pi, config, modelKey);

  const model = config.models[modelKey];
  if (!model) return false;

  const apiModelId = resolveApiModelId(modelKey, model);
  ctx?.ui?.setStatus?.("llama-switch", `⚡ ${model.name}`);

  if (ctx?.modelRegistry?.find && typeof pi.setModel === "function") {
    const registered = ctx.modelRegistry.find(PROVIDER_ID, apiModelId);
    if (!registered) return false;
    try {
      return await pi.setModel(registered);
    } catch {
      return false;
    }
  }

  return false;
}

async function handleInteractiveSwitch(
  pi: ExtensionAPI,
  config: SwitcherConfig,
  ctx: any
): Promise<void> {
  const snapshot = config;
  const state = getState();
  const entries = Object.entries(snapshot.models).map(([key, model]) => {
    const isCurrent = state.activeModelKey === key;
    const vision = model.vision ? " [vision]" : "";
    const tags = model.tags?.length ? ` (${model.tags.join(", ")})` : "";
    return {
      label: `${isCurrent ? "► " : "  "}${key} - ${model.name}${vision}${tags}`,
      value: key,
      description: model.description,
    };
  });

  const choice = await ctx.ui.select(
    "Switch to model:",
    entries.map((e) => e.label)
  );

  if (!choice) return;

  const selectedEntry = entries.find((e) => e.label === choice);
  if (!selectedEntry) return;

  const modelKey = selectedEntry.value;
  const model = snapshot.models[modelKey];
  if (!model) return;

  if (state.activeModelKey === modelKey) {
    ctx.ui.notify(`Already using ${model.name}`, "info");
    return;
  }

  try {
    ctx.ui.notify(`Switching to ${model.name}...`, "info");
    await switchModel(snapshot, modelKey, {
      onStatusUpdate: (msg) => {
        ctx.ui.notify(msg, "info");
      },
    });

    const selected = await activateModel(pi, snapshot, modelKey, ctx);
    ctx.ui.notify(
      `Switched to ${model.name}${selected ? "" : " — select it via /model if needed"}`,
      "info"
    );
  } catch (err: any) {
    ctx.ui.notify(`Switch failed: ${err.message}`, "error");
  }
}

async function handleDirectSwitch(
  pi: ExtensionAPI,
  config: SwitcherConfig,
  modelKey: string,
  ctx: any
): Promise<void> {
  const snapshot = config;
  const state = getState();
  const model = snapshot.models[modelKey];
  if (!model) {
    ctx.ui.notify(`Unknown model: '${modelKey}'`, "error");
    return;
  }

  if (state.activeModelKey === modelKey) {
    ctx.ui.notify(`Already using ${model.name}`, "info");
    return;
  }

  try {
    ctx.ui.notify(`Switching to ${model.name}...`, "info");
    await switchModel(snapshot, modelKey, {
      onStatusUpdate: (msg) => {
        ctx.ui.notify(msg, "info");
      },
    });

    const selected = await activateModel(pi, snapshot, modelKey, ctx);
    ctx.ui.notify(
      `Switched to ${model.name}${selected ? "" : " — select it via /model if needed"}`,
      "info"
    );
  } catch (err: any) {
    ctx.ui.notify(`Switch failed: ${err.message}`, "error");
  }
}

function handleList(config: SwitcherConfig, ctx: any): void {
  const state = getState();
  const lines = Object.entries(config.models).map(([key, model]) => {
    const isCurrent = state.activeModelKey === key;
    const icon = isCurrent ? "►" : " ";
    const vision = model.vision ? " [vision]" : "";
    const tags = model.tags?.length ? ` (${model.tags.join(", ")})` : "";
    return `${icon} ${key} - ${model.name}${vision}${tags}\n    ${model.description} | ctx: ${model.contextWindow}`;
  });

  ctx.ui.notify(
    `Models:\n${lines.join("\n\n")}`,
    "info"
  );
}

export function handleStatus(config: SwitcherConfig, ctx: any): void {
  const state = getState();
  const model = state.activeModelKey
    ? config.models[state.activeModelKey]
    : undefined;

  if (model) {
    ctx.ui.notify(
      `Active: ${model.name} (${model.description})\n` +
        `Context: ${model.contextWindow} tokens\n` +
        `PID: ${state.activePid ?? "unknown"}\n` +
        `Server: ${formatServerUrl(config.server.host, config.server.port)}`,
      "info"
    );
  } else if (state.activeModelKey || state.activePid) {
    ctx.ui.notify(
      `Active: ${state.activeModelKey ?? "unlisted model"} (not in current config)\n` +
        `PID: ${state.activePid ?? "unknown"}\n` +
        `Server: ${formatServerUrl(config.server.host, config.server.port)}`,
      "info"
    );
  } else {
    ctx.ui.notify("No model currently loaded", "info");
  }
}

export async function handleReload(
  pi: ExtensionAPI,
  ctx: any,
  setConfig: (next: SwitcherConfig) => void
): Promise<void> {
  if (getState().isSwitching) {
    ctx.ui.notify(
      "Cannot reload config while a model switch is in progress",
      "error"
    );
    return;
  }

  let newConfig: SwitcherConfig | null;
  try {
    newConfig = loadConfig();
  } catch (err: any) {
    ctx.ui.notify(`Failed to reload config: ${err.message}`, "error");
    return;
  }

  if (!newConfig) {
    ctx.ui.notify("Failed to reload config: file not found", "error");
    return;
  }

  setConfig(newConfig);
  const state = getState();
  const modelCount = Object.keys(newConfig.models).length;

  if (state.activeModelKey && !newConfig.models[state.activeModelKey]) {
    const droppedKey = state.activeModelKey;
    clearActiveModelKey();

    if (newConfig.defaultModel && newConfig.models[newConfig.defaultModel]) {
      registerProvider(pi, newConfig, newConfig.defaultModel);
    }

    ctx.ui.setStatus("llama-switch", "⚠ unlisted model running");
    ctx.ui.notify(
      `Reloaded config: ${modelCount} models. Active model '${droppedKey}' was removed; the current server stays running until the next /switch.`,
      "warning"
    );
    return;
  }

  if (state.activeModelKey) {
    await activateModel(pi, newConfig, state.activeModelKey, ctx);
  } else if (newConfig.defaultModel && newConfig.models[newConfig.defaultModel]) {
    registerProvider(pi, newConfig, newConfig.defaultModel);
  }

  ctx.ui.notify(`Reloaded config: ${modelCount} models`, "info");
}

function handleLogs(ctx: any): void {
  const logPath = join(homedir(), ".pi", "agent", "llama-switch.log");

  try {
    const content = readFileSync(logPath, "utf-8");
    const lines = content.split("\n").slice(-50).join("\n");
    ctx.ui.notify(`Last 50 lines of ${logPath}:\n${lines}`, "info");
  } catch {
    ctx.ui.notify(`No log file found at ${logPath}`, "info");
  }
}

/**
 * Extracts the primary model identifier from a configured command. Secondary
 * artifacts (--mmproj, --draft, ...) are explicitly skipped so they cannot be
 * mistaken for the main model.
 */
export function extractModelMatchTokens(command: string[]): string[] {
  const tokens: string[] = [];

  const servedName = findFlagValue(command, ["--served-model-name"]);
  if (servedName) tokens.push(servedName);

  // `python3 -m <module>` uses -m for the module, not the model.
  const pythonModuleFlag =
    command[1] === "-m" && /python/i.test(basename(command[0]));
  const modelFlag = findFlagValue(
    command,
    pythonModuleFlag ? ["--model"] : ["-m", "--model"]
  );
  if (modelFlag) tokens.push(modelFlag);

  const hfRepo = findFlagValue(command, ["--hf-repo", "-hf"]);
  if (hfRepo) tokens.push(hfRepo);

  if (tokens.length === 0) {
    const serveIndex = command.indexOf("serve");
    if (serveIndex !== -1) {
      const positional = command[serveIndex + 1];
      if (positional && !positional.startsWith("-")) {
        tokens.push(positional);
      }
    }
  }

  if (tokens.length === 0) {
    for (let i = 0; i < command.length; i++) {
      const arg = command[i];
      if (SECONDARY_MODEL_FLAGS.includes(arg)) {
        i++;
        continue;
      }
      if (SECONDARY_MODEL_FLAGS.some((flag) => arg.startsWith(`${flag}=`))) {
        continue;
      }
      if (arg.toLowerCase().endsWith(".gguf")) {
        tokens.push(arg);
        break;
      }
    }
  }

  return tokens;
}

/**
 * Identifies which configured model a running process serves. Models sharing a
 * primary model file are disambiguated by secondary flags (--mmproj, --ctx-size,
 * --max-model-len, --alias, --served-model-name).
 */
export function detectModelFromArgs(
  config: SwitcherConfig,
  procArgs: string
): string | null {
  let best: { key: string; score: number } | null = null;

  for (const [key, model] of Object.entries(config.models)) {
    const tokens = extractModelMatchTokens(model.command);
    if (tokens.length === 0) continue;
    if (!tokens.some((token) => commandLineHasToken(procArgs, token))) {
      continue;
    }

    let score = 0;
    for (const flag of DISTINGUISHING_FLAGS) {
      const value = findFlagValue(model.command, [flag]);
      if (value && commandLineHasToken(procArgs, value)) {
        score++;
      }
    }

    if (!best || score > best.score) {
      best = { key, score };
    }
  }

  return best?.key ?? null;
}

function detectModelFromPid(config: SwitcherConfig, pid: number): string | null {
  try {
    const args = execSync(`ps -p ${pid} -o args=`, {
      encoding: "utf-8",
      timeout: 3000,
    }).trim();

    return detectModelFromArgs(config, args);
  } catch {
    // ps not available or other error
  }

  return null;
}
