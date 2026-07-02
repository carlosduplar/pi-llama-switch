# pi-llama-switch

<div align="center">

<!-- Add a cover image: docs/cover.png -->
Restart [llama-server](https://github.com/ggml-org/llama.cpp) with different model configurations. For single-model setups where each model needs different flags -- context size, vision projector, sampling params, GPU offload.

[![npm version](https://img.shields.io/npm/v/pi-llama-switch.svg)](https://www.npmjs.com/package/pi-llama-switch)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

</div>

## Features

- **`/switch` command** -- interactive model picker or direct switch with `/switch qwen`
- **`model_switch` tool** -- the LLM can request a switch programmatically
- **Health checking** -- polls llama-server `/health` endpoint with progress updates
- **Provider registration** -- after switch, Pi natively knows the active model via `/model` and `Ctrl+P`
- **PID tracking** -- clean process lifecycle management with graceful shutdown
- **Stderr logging** -- captures startup failures to `~/.pi/agent/llama-switch.log`
- **Auto-reconnect** -- reconnects to a running server on Pi restart

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

### Config fields

| Field | Required | Description |
|---|---|---|
| `server.host` | yes | llama-server bind address |
| `server.port` | yes | llama-server port |
| `server.healthTimeout` | no | Seconds to wait for `/health` (default: 60) |
| `server.portReleaseTimeout` | no | Seconds to wait for port release after kill (default: 15) |
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

1. Kills the current llama-server via `SIGTERM` (tracked PID, not `pkill`)
2. Waits for the port to be released
3. Spawns a new server with the model's command array
4. Polls `/health` until `status === "ok"` (or errors immediately on `status: "error"`)
5. Registers the new model with Pi's provider system

## vs pi-llama-cpp

| | pi-llama-cpp | pi-llama-switch |
|---|---|---|
| **Operation** | Load/unload within running server | Kill + restart with new config |
| **Use case** | Multi-model router, hot swap | Single-model, different flags per model |
| **Vision support** | Detects existing mmproj | Switches `--mmproj` flag |
| **Context size** | Uses server's configured size | Changes `--ctx-size` per model |

They complement each other. Use `pi-llama-cpp` if your server runs multiple models simultaneously. Use `pi-llama-switch` if each model needs its own server configuration.

## License

[![npm version](https://img.shields.io/npm/v/pi-llama-switch.svg)](https://www.npmjs.com/package/pi-llama-switch)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

MIT
