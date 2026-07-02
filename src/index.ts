import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { readFileSync } from "node:fs";
import { loadConfig, type SwitcherConfig } from "./config.js";
import {
  getState,
  readPidFile,
  isProcessAlive,
  isLlamaServer,
  switchModel,
  disconnectState,
  deletePidFile,
} from "./switcher.js";
import { checkHealth } from "./health.js";
import { buildProviderModels, getModelForProvider } from "./provider.js";

const PROVIDER_ID = "llama-local";

export default async function (pi: ExtensionAPI) {
  const config = loadConfig();

  if (!config) {
    console.warn(
      "[pi-llama-switch] No config found at ~/.pi/agent/model-switcher.json"
    );
    return;
  }

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
        return handleReload(pi, ctx);
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
      "model_switch kills the current llama-server and restarts with a new configuration. This takes 10-60 seconds depending on model size.",
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
      const modelKey = params.model;
      const dryRun = params.dryRun ?? false;

      if (!config.models[modelKey]) {
        const available = Object.keys(config.models).join(", ");
        return {
          content: [
            {
              type: "text",
              text: `Model '${modelKey}' not found. Available: ${available}`,
            },
          ],
          details: { error: "model_not_found", available: Object.keys(config.models) },
        };
      }

      if (dryRun) {
        const model = config.models[modelKey];
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
        content: [{ type: "text", text: `Switching to ${config.models[modelKey].name}...` }],
        details: { phase: "switching", model: modelKey },
      });

      try {
        await switchModel(config, modelKey, {
          onStatusUpdate: (msg) => {
            onUpdate?.({ content: [{ type: "text", text: msg }], details: { phase: "switching", model: modelKey } });
          },
        }, signal);

        registerProvider(pi, config, modelKey);

        const model = config.models[modelKey];
        return {
          content: [
            {
              type: "text",
              text: `Switched to ${model.name} (${model.description}). Context window: ${model.contextWindow} tokens.`,
            },
          ],
          details: {
            switched: true,
            model: modelKey,
            name: model.name,
            contextWindow: model.contextWindow,
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
    const pid = readPidFile();
    if (pid && isProcessAlive(pid) && isLlamaServer(pid)) {
      const alive = await checkHealth(config.server.host, config.server.port);
      if (alive) {
        // Detect active model from config
        const state = getState();
        if (!state.activeModelKey) {
          // Try to figure out which model is running by checking the process args
          const modelKey = detectModelFromPid(config, pid);
          if (modelKey) {
            registerProvider(pi, config, modelKey);
          }
        }
        ctx.ui.setStatus("llama-switch", `⚡ ${config.defaultModel}`);
        return;
      }
    }

    // No running server found
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
  const models = buildProviderModels(config);
  const activeModel = models.find((m) => m.id === modelKey);
  if (!activeModel) return;

  pi.registerProvider(PROVIDER_ID, {
    baseUrl: `http://${config.server.host}:${config.server.port}/v1`,
    apiKey: "no-key",
    api: "openai-completions",
    models: models.map((m) => ({
      ...m,
      reasoning: m.id === modelKey ? (activeModel.reasoning ?? false) : false,
    })),
  });
}

async function handleInteractiveSwitch(
  pi: ExtensionAPI,
  config: SwitcherConfig,
  ctx: any
): Promise<void> {
  const state = getState();
  const entries = Object.entries(config.models).map(([key, model]) => {
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

  if (state.activeModelKey === modelKey) {
    ctx.ui.notify(`Already using ${config.models[modelKey].name}`, "info");
    return;
  }

  try {
    ctx.ui.notify(`Switching to ${config.models[modelKey].name}...`, "info");
    await switchModel(config, modelKey, {
      onStatusUpdate: (msg) => {
        ctx.ui.notify(msg, "info");
      },
    });

    registerProvider(pi, config, modelKey);
    ctx.ui.notify(`Switched to ${config.models[modelKey].name}`, "info");
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
  const state = getState();
  if (state.activeModelKey === modelKey) {
    ctx.ui.notify(`Already using ${config.models[modelKey].name}`, "info");
    return;
  }

  try {
    ctx.ui.notify(`Switching to ${config.models[modelKey].name}...`, "info");
    await switchModel(config, modelKey, {
      onStatusUpdate: (msg) => {
        ctx.ui.notify(msg, "info");
      },
    });

    registerProvider(pi, config, modelKey);
    ctx.ui.notify(`Switched to ${config.models[modelKey].name}`, "info");
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

function handleStatus(config: SwitcherConfig, ctx: any): void {
  const state = getState();
  if (state.activeModelKey) {
    const model = config.models[state.activeModelKey];
    ctx.ui.notify(
      `Active: ${model.name} (${model.description})\n` +
        `Context: ${model.contextWindow} tokens\n` +
        `PID: ${state.activePid ?? "unknown"}\n` +
        `Server: http://${config.server.host}:${config.server.port}`,
      "info"
    );
  } else {
    ctx.ui.notify("No model currently loaded", "info");
  }
}

function handleReload(pi: ExtensionAPI, ctx: any): void {
  const newConfig = loadConfig();
  if (!newConfig) {
    ctx.ui.notify("Failed to reload config: file not found", "error");
    return;
  }
  ctx.ui.notify(
    `Reloaded config: ${Object.keys(newConfig.models).length} models`,
    "info"
  );
}

function handleLogs(ctx: any): void {
  const logPath = require("node:path").join(
    require("node:os").homedir(),
    ".pi",
    "agent",
    "llama-switch.log"
  );

  try {
    const content = readFileSync(logPath, "utf-8");
    const lines = content.split("\n").slice(-50).join("\n");
    ctx.ui.notify(`Last 50 lines of ${logPath}:\n${lines}`, "info");
  } catch {
    ctx.ui.notify(`No log file found at ${logPath}`, "info");
  }
}

function detectModelFromPid(config: SwitcherConfig, pid: number): string | null {
  try {
    const { execSync } = require("node:child_process");
    const cmdline = execSync(`cat /proc/${pid}/cmdline`, {
      encoding: "utf-8",
      timeout: 1000,
    });

    for (const [key, model] of Object.entries(config.models)) {
      // Check if the model's GGUF path appears in the cmdline
      const ggufArg = model.command.find((arg) => arg.endsWith(".gguf"));
      if (ggufArg && cmdline.includes(ggufArg)) {
        return key;
      }
    }
  } catch {
    // /proc not available (macOS) or other error
  }

  return config.defaultModel || null;
}
