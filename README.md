# pi-llama-switch

<div align="center">

<!-- Add a cover image: docs/cover.png -->
Restart local LLM servers with different model configurations. For single-model setups where each model needs different flags: context size, vision projector, sampling params, GPU offload. Works with [llama.cpp](https://github.com/ggml-org/llama.cpp) and [vLLM](https://github.com/vllm-project/vllm) (experimental).

[![npm version](https://img.shields.io/npm/v/pi-llama-switch.svg)](https://www.npmjs.com/package/pi-llama-switch)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

</div>

## Features

- **`/switch` command** -- interactive model picker or direct switch with `/switch qwen`
- **`model_switch` tool** -- the LLM can request a switch programmatically
- **Health checking** -- polls `/health` endpoint with progress updates
- **Provider registration** -- after switch, Pi natively knows the active model via `/model` and `Ctrl+P`
- **PID tracking** -- clean process lifecycle management with graceful shutdown
- **Stderr logging** -- captures startup failures to `~/.pi/agent/llama-switch.log`
- **Auto-reconnect** -- reconnects to a running server on Pi restart
- **Multi-backend** -- works with llama.cpp and vLLM (experimental)

## Who is this for

You have a single GPU and multiple local models, but each model needs different server flags. Instead of maintaining separate terminals or scripts, you switch between them with `/switch`.

**Common setups:**

- **Coding vs general-purpose:** Qwen3.6 for code (small context, fast) and Gemma 4 for general tasks (vision, larger context) -- each with different `--ctx-size` and `--mmproj` flags.
- **Fast vs powerful:** A smaller model for quick tasks and a large one for complex reasoning -- small model loads in seconds, large one needs more time and VRAM.
- **Text vs multimodal:** A text-only model for coding and a vision model for image analysis -- vision model needs `--mmproj`, which adds VRAM overhead.

If you only run one model at a time and don't change server flags between models, you don't need this extension.

## Install

```bash
pi install npm:pi-llama-switch
```

Then restart your Pi session.

## Config

Copy `examples/model-switcher.json` to `~/.pi/agent/model-switcher.json` and edit:

```json
{
  "server": {
    "host": "127.0.0.1",
    "port": 8080,
    "healthTimeout": 60,
    "portReleaseTimeout": 15
  },
  "defaultModel": "qwen",
  "models": {
    "qwen": {
      "name": "Qwen3.6 35B-A3B",
      "description": "Coding/Reasoning",
      "command": [
        "llama-server",
        "-m", "~/models/qwen/Qwen3.6-35B-A3B.gguf",
        "-ngl", "999",
        "--flash-attn", "on",
        "--cache-type-k", "q8_0",
        "--cache-type-v", "q8_0",
        "--ctx-size", "8192",
        "--parallel", "1",
        "--host", "127.0.0.1",
        "--port", "8080"
      ],
      "vision": false,
      "contextWindow": 8192,
      "maxTokens": 4096,
      "tags": ["coding", "reasoning"]
    }
  }
}
```

### vLLM

The extension should also work with vLLM. See `examples/model-switcher-vllm.json` for a full example:

```json
{
  "server": {
    "host": "127.0.0.1",
    "port": 8000,
    "healthTimeout": 120,
    "portReleaseTimeout": 15
  },
  "defaultModel": "qwen",
  "models": {
    "qwen": {
      "name": "Qwen3.6-35B-A3B",
      "description": "Coding/Reasoning",
      "command": [
        "python3", "-m", "vllm.entrypoints.openai.api_server",
        "--model", "~/models/qwen/Qwen3.6-35B-A3B",
        "--tensor-parallel-size", "1",
        "--gpu-memory-utilization", "0.9",
        "--max-model-len", "8192",
        "--host", "127.0.0.1",
        "--port", "8000"
      ],
      "vision": false,
      "contextWindow": 8192,
      "maxTokens": 4096,
      "tags": ["coding", "reasoning"]
    }
  }
}
```

> [!NOTE]
> vLLM support is verified against docs but not tested end-to-end. The health endpoint and OpenAI-compatible API are standard. Report issues if you test this.

### Config fields

| Field | Required | Description |
|---|---|---|
| `server.host` | yes | Server bind address |
| `server.port` | yes | Server port |
| `server.healthTimeout` | no | Seconds to wait for `/health` (default: 60) |
| `server.portReleaseTimeout` | no | Seconds to wait for port release after stop (default: 30) |
| `defaultModel` | no | Model key active on startup (default: first model) |
| `models.<key>.name` | yes | Display name |
| `models.<key>.description` | yes | Short description |
| `models.<key>.command` | yes | Array-style command (no shell parsing needed) |
| `models.<key>.vision` | no | Whether model supports images (default: false) |
| `models.<key>.contextWindow` | no | Max context tokens for Pi (default: 8192) |
| `models.<key>.maxTokens` | no | Max output tokens for Pi (default: 4096) |
| `models.<key>.tags` | no | Tags for filtering (default: []) |

## Commands

| Command | Description |
|---|---|
| `/switch` | Interactive model picker |
| `/switch qwen` | Switch directly to model key |
| `/switch list` | Print all available models |
| `/switch status` | Show active model + server health |
| `/switch reload` | Re-read config file |
| `/switch logs` | Tail the last 50 lines of the log |

## Tool

The `model_switch` tool lets the LLM switch models programmatically:

```typescript
model_switch({
  model: "qwen",        // model key from config
  dryRun: false         // optional: print command without executing
})
```

### Schema

```ts
model_switch({
  model: string,         // required: model key
  dryRun?: boolean,      // optional: preview mode
})
```

Returns:

```ts
{
  content: [{ type: "text", text: string }],
  details: {
    switched: boolean,
    model: string,
    name: string,
    contextWindow: number,
    error?: string,
  }
}
```

## How it works

1. Stops the current server via `SIGTERM` (tracked PID, not `pkill`)
2. Waits for the port to be released
3. Spawns a new server with the model's command array
4. Polls `/health` until `status === "ok"` (or errors immediately on `status: "error"`)
5. Registers the new model with Pi's provider system

## Troubleshooting

**Startup timeout:** Increase `server.healthTimeout` in your config. Large models on low VRAM can take 60+ seconds to load. vLLM models may need even longer for initial weight loading.

**Logs:** Check `~/.pi/agent/llama-switch.log` for stderr output:
```bash
# From Pi
/switch logs

# From terminal
tail -50 ~/.pi/agent/llama-switch.log
tail -f ~/.pi/agent/llama-switch.log  # follow in real time
```

**Port still in use after stop:** Increase `server.portReleaseTimeout` (default: 30s). Large context sizes take longer to flush KV cache.

**Switch failed, server still running:** The extension kills orphaned processes on failure. If something slips through:
```bash
lsof -ti:8080 | xargs kill -9
```

**Config not reloading:** Run `/switch reload` after editing `~/.pi/agent/model-switcher.json`. Verify JSON validity first.

## License

MIT
