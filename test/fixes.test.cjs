"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

// Isolate all PID/log/config writes from the real ~/.pi/agent.
const TEST_HOME = path.join(os.tmpdir(), `pi-llama-switch-test-${process.pid}`);
const AGENT_DIR = path.join(TEST_HOME, ".pi", "agent");
fs.mkdirSync(AGENT_DIR, { recursive: true });
process.env.USERPROFILE = TEST_HOME;
process.env.HOME = TEST_HOME;

const {
  formatHostForUrl,
  formatServerUrl,
  loadConfig,
  normalizeHostForSocket,
} = require("../.test-dist/config.js");
const { checkHealth, waitForHealth } = require("../.test-dist/health.js");
const {
  buildProviderModels,
  resolveApiModelId,
} = require("../.test-dist/provider.js");
const {
  getState,
  hasPortArg,
  isManagedServerCommand,
  switchModel,
} = require("../.test-dist/switcher.js");
const {
  activateModel,
  detectModelFromArgs,
  extractModelMatchTokens,
  handleReload,
  handleStatus,
} = require("../.test-dist/index.js");

after(() => {
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

function model(overrides = {}) {
  return {
    name: "Test Model",
    description: "Test model",
    command: ["llama-server", "-m", "/models/test.gguf"],
    vision: false,
    contextWindow: 8192,
    maxTokens: 4096,
    tags: [],
    ...overrides,
  };
}

function configWith(models, server = {}) {
  return {
    server: {
      host: "127.0.0.1",
      port: 59999,
      healthTimeout: 5,
      portReleaseTimeout: 5,
      ...server,
    },
    defaultModel: Object.keys(models)[0],
    models,
  };
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// --- IPv6 URL helpers -------------------------------------------------------

test("formatServerUrl brackets bare IPv6 hosts and leaves bracketed ones", () => {
  assert.equal(formatServerUrl("::1", 8080, "/health"), "http://[::1]:8080/health");
  assert.equal(formatServerUrl("[::1]", 8080, "/v1"), "http://[::1]:8080/v1");
  assert.equal(formatServerUrl("127.0.0.1", 8080, "/health"), "http://127.0.0.1:8080/health");
  assert.equal(formatHostForUrl("fe80::1"), "[fe80::1]");
  assert.equal(normalizeHostForSocket("[::1]"), "::1");
  assert.equal(normalizeHostForSocket("::1"), "::1");
  assert.equal(normalizeHostForSocket("127.0.0.1"), "127.0.0.1");
});

// --- Port argument parsing --------------------------------------------------

test("hasPortArg matches only explicit exact --port values", () => {
  assert.equal(hasPortArg("llama-server --port 8080", 8080), true);
  assert.equal(hasPortArg("llama-server --port=8080", 8080), true);
  assert.equal(hasPortArg("llama-server --port 18080", 8080), false);
  assert.equal(hasPortArg("llama-server --port 80801", 8080), false);
  assert.equal(hasPortArg("llama-server -m foo-8080.gguf --port 9000", 8080), false);
  assert.equal(hasPortArg("llama-server -p 8080", 8080), false);
  assert.equal(hasPortArg("llama-server --port 9000 --port 8080", 8080), true);
  assert.equal(hasPortArg("llama-server --port 8080 --port 9000", 8080), false);
});

// --- Managed server detection ----------------------------------------------

test("isManagedServerCommand recognizes llama-server and vLLM", () => {
  assert.equal(isManagedServerCommand("llama-server -m /models/a.gguf"), true);
  assert.equal(
    isManagedServerCommand(
      "python3 -m vllm.entrypoints.openai.api_server --port 8000"
    ),
    true
  );
  assert.equal(isManagedServerCommand("vllm serve org/model --port 8000"), true);
  assert.equal(isManagedServerCommand("python3 my_script.py"), false);
  assert.equal(isManagedServerCommand("node server.js"), false);
});

test("isManagedServerCommand honors configured non-generic executables", () => {
  const config = configWith({
    custom: model({ command: ["/opt/my-llama-server", "-m", "/models/a.gguf"] }),
  });
  assert.equal(
    isManagedServerCommand("/opt/my-llama-server -m /models/a.gguf", config),
    true
  );
  assert.equal(isManagedServerCommand("/opt/other-binary --port 8080", config), false);
});

// --- API model ID resolution ------------------------------------------------

test("resolveApiModelId follows documented precedence", () => {
  const served = model({
    command: ["llama-server", "-m", "/m.gguf", "--alias", "aliased", "--served-model-name", "served"],
  });
  assert.equal(resolveApiModelId("key", served), "served");
  assert.equal(
    resolveApiModelId("key", { ...served, modelId: "org/model" }),
    "org/model"
  );

  assert.equal(
    resolveApiModelId("key", model({ command: ["llama-server", "-m", "/m.gguf", "--alias", "aliased"] })),
    "aliased"
  );
  assert.equal(
    resolveApiModelId("key", model({ command: ["llama-server", "-a", "short"] })),
    "short"
  );
  assert.equal(
    resolveApiModelId("key", model({ command: ["llama-server", "--alias=eq"] })),
    "eq"
  );
  assert.equal(
    resolveApiModelId("key", model({ command: ["llama-server", "-m", "/m.gguf"] })),
    "key"
  );
});

test("resolveApiModelId resolves vLLM served models", () => {
  const moduleCommand = [
    "python3",
    "-m",
    "vllm.entrypoints.openai.api_server",
    "--model",
    "/models/qwen",
  ];
  assert.equal(
    resolveApiModelId("qwen", model({ command: moduleCommand })),
    "/models/qwen"
  );
  assert.equal(
    resolveApiModelId("qwen", model({ command: ["vllm", "serve", "org/model", "--port", "8000"] })),
    "org/model"
  );
  assert.equal(
    resolveApiModelId(
      "qwen",
      model({ command: [...moduleCommand, "--served-model-name", "qwen-api"] })
    ),
    "qwen-api"
  );
});

test("vLLM example config parses and resolves both served names", () => {
  const examplePath = path.join(__dirname, "..", "examples", "model-switcher-vllm.json");
  const config = loadConfig(examplePath);
  assert.ok(config);
  assert.equal(resolveApiModelId("qwen", config.models.qwen), "qwen");
  assert.equal(resolveApiModelId("llama", config.models.llama), "llama");
  assert.deepEqual(
    buildProviderModels(config).map((m) => m.id).sort(),
    ["llama", "qwen"]
  );
});

test("config validation rejects empty modelId and unknown defaultModel", () => {
  const invalidModelId = path.join(TEST_HOME, "invalid-model-id.json");
  fs.writeFileSync(
    invalidModelId,
    JSON.stringify({
      server: { host: "127.0.0.1", port: 8080 },
      models: { a: { name: "A", description: "A", command: ["llama-server"], modelId: "  " } },
    })
  );
  assert.throws(() => loadConfig(invalidModelId), /modelId must be a non-empty string/);

  const invalidDefault = path.join(TEST_HOME, "invalid-default.json");
  fs.writeFileSync(
    invalidDefault,
    JSON.stringify({
      server: { host: "127.0.0.1", port: 8080 },
      defaultModel: "missing",
      models: { a: { name: "A", description: "A", command: ["llama-server"] } },
    })
  );
  assert.throws(() => loadConfig(invalidDefault), /defaultModel 'missing' not found/);

  const emptyDefault = path.join(TEST_HOME, "empty-default.json");
  fs.writeFileSync(
    emptyDefault,
    JSON.stringify({
      server: { host: "127.0.0.1", port: 8080 },
      defaultModel: "",
      models: { a: { name: "A", description: "A", command: ["llama-server"] } },
    })
  );
  const fallback = loadConfig(emptyDefault);
  assert.ok(fallback);
  assert.equal(fallback.defaultModel, "a");
  assert.equal(fallback.models.a.modelId, undefined);
});

// --- Model selection in Pi --------------------------------------------------

test("activateModel selects the resolved API model id and preserves reasoning", async () => {
  const config = configWith(
    {
      qwen: model({
        name: "Qwen",
        command: ["llama-server", "--served-model-name", "qwen-api", "-m", "/q.gguf"],
        tags: ["reasoning"],
      }),
      gemma: model({
        name: "Gemma",
        command: ["llama-server", "--served-model-name", "gemma-api", "-m", "/g.gguf"],
        tags: ["reasoning"],
      }),
    },
    { host: "::1", port: 8080 }
  );

  let registered;
  const selected = [];
  const statuses = [];
  const pi = {
    registerProvider(providerId, options) {
      registered = { providerId, options };
    },
    async setModel(m) {
      selected.push(m);
      return true;
    },
  };
  const ctx = {
    ui: {
      notify() {},
      setStatus(key, value) {
        statuses.push([key, value]);
      },
    },
    modelRegistry: {
      find(provider, id) {
        return id === "qwen-api" ? { provider, id } : undefined;
      },
    },
  };

  const ok = await activateModel(pi, config, "qwen", ctx);

  assert.equal(ok, true);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].id, "qwen-api");
  assert.equal(registered.providerId, "llama-local");
  assert.equal(registered.options.baseUrl, "http://[::1]:8080/v1");
  assert.deepEqual(
    registered.options.models.map((m) => m.id).sort(),
    ["gemma-api", "qwen-api"]
  );
  assert.equal(
    registered.options.models.find((m) => m.id === "gemma-api").reasoning,
    true
  );
  assert.deepEqual(statuses.at(-1), ["llama-switch", "⚡ Qwen"]);

  const notFound = await activateModel(pi, config, "qwen", {
    ...ctx,
    modelRegistry: { find: () => undefined },
  });
  assert.equal(notFound, false);
});

// --- Process lifecycle ------------------------------------------------------

test("switchModel reports ENOENT without crashing and closes the log fd", async () => {
  const port = await getFreePort();
  const config = configWith(
    { ghost: model({ command: ["definitely-not-a-real-binary-xyz"] }) },
    { port }
  );

  const openedFds = new Set();
  let opened = 0;
  let closed = 0;
  const realOpen = fs.openSync;
  const realClose = fs.closeSync;

  fs.openSync = function (file, ...args) {
    const fd = realOpen.call(this, file, ...args);
    if (String(file).endsWith("llama-switch.log")) {
      opened++;
      openedFds.add(fd);
    }
    return fd;
  };
  fs.closeSync = function (fd) {
    if (openedFds.delete(fd)) {
      closed++;
    }
    return realClose.call(this, fd);
  };

  try {
    await assert.rejects(
      () => switchModel(config, "ghost"),
      /Failed to start definitely-not-a-real-binary-xyz/
    );
  } finally {
    fs.openSync = realOpen;
    fs.closeSync = realClose;
  }

  assert.equal(opened, 1);
  assert.equal(closed, 1);
  assert.equal(openedFds.size, 0);
  assert.equal(getState().activePid, null);
  assert.equal(getState().activeModelKey, null);
});

// --- Health checks ----------------------------------------------------------

test("waitForHealth rejects on a stalled server instead of hanging", async () => {
  const server = http.createServer(() => {
    // Never respond.
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  const started = Date.now();
  try {
    await assert.rejects(
      () =>
        waitForHealth({
          host: "127.0.0.1",
          port,
          healthTimeout: 1,
          portReleaseTimeout: 1,
        }),
      /timed out after 1s/
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 3000, `expected a fast rejection, took ${elapsed}ms`);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("checkHealth honors its own timeout", async () => {
  const server = http.createServer(() => {
    // Never respond.
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  const started = Date.now();
  try {
    assert.equal(await checkHealth("127.0.0.1", port, 300), false);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 2000, `expected a fast rejection, took ${elapsed}ms`);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

// --- Model detection from a running process --------------------------------

test("extractModelMatchTokens skips secondary artifacts", () => {
  assert.deepEqual(
    extractModelMatchTokens([
      "llama-server",
      "--mmproj",
      "/models/mm.gguf",
      "-m",
      "/models/shared.gguf",
    ]),
    ["/models/shared.gguf"]
  );
  assert.deepEqual(
    extractModelMatchTokens([
      "python3",
      "-m",
      "vllm.entrypoints.openai.api_server",
      "--model",
      "/models/qwen",
    ]),
    ["/models/qwen"]
  );
});

test("detectModelFromArgs disambiguates models sharing a GGUF", () => {
  const config = configWith({
    a: model({
      command: [
        "llama-server",
        "-m",
        "/models/shared.gguf",
        "--mmproj",
        "/models/mm.gguf",
        "--ctx-size",
        "8192",
      ],
    }),
    b: model({
      command: [
        "llama-server",
        "--mmproj",
        "/models/mm.gguf",
        "-m",
        "/models/shared.gguf",
        "--ctx-size",
        "16384",
      ],
    }),
  });

  const procArgsA =
    "llama-server -m /models/shared.gguf --mmproj /models/mm.gguf --ctx-size 8192 --port 8080";
  const procArgsB =
    "llama-server --mmproj /models/mm.gguf -m /models/shared.gguf --ctx-size 16384 --port 8080";

  assert.equal(detectModelFromArgs(config, procArgsA), "a");
  assert.equal(detectModelFromArgs(config, procArgsB), "b");
  assert.equal(detectModelFromArgs(config, "python3 other_script.py"), null);
  assert.equal(
    detectModelFromArgs(
      config,
      "llama-server -m /models/shared.gguf.bak --mmproj /models/mm.gguf --ctx-size 8192"
    ),
    null
  );
});

test("detectModelFromArgs recognizes vLLM model flags and serve positional", () => {
  const config = configWith({
    qwen: model({
      command: [
        "python3",
        "-m",
        "vllm.entrypoints.openai.api_server",
        "--model",
        "/models/qwen",
        "--served-model-name",
        "qwen-api",
      ],
    }),
    llama: model({
      command: [
        "python3",
        "-m",
        "vllm.entrypoints.openai.api_server",
        "--model",
        "/models/llama",
      ],
    }),
    served: model({
      command: ["vllm", "serve", "org/model-s", "--port", "8000"],
    }),
  });

  assert.equal(
    detectModelFromArgs(
      config,
      "python3 -m vllm.entrypoints.openai.api_server --model /models/llama --port 8000"
    ),
    "llama"
  );
  assert.equal(
    detectModelFromArgs(
      config,
      "python3 -m vllm.entrypoints.openai.api_server --model /models/qwen --served-model-name qwen-api --port 8000"
    ),
    "qwen"
  );
  assert.equal(
    detectModelFromArgs(config, "vllm serve org/model-s --port 8000"),
    "served"
  );
});

// --- Reload safety ----------------------------------------------------------

function writeConfigFile(config) {
  fs.writeFileSync(
    path.join(AGENT_DIR, "model-switcher.json"),
    JSON.stringify(config)
  );
}

test("handleReload refuses to run while a switch is in progress", async () => {
  const state = getState();
  const notifications = [];
  let setConfigCalls = 0;
  const pi = { registerProvider() {} };
  const ctx = {
    ui: {
      notify(message, type) {
        notifications.push([type, message]);
      },
      setStatus() {},
    },
  };

  state.isSwitching = true;
  try {
    await handleReload(pi, ctx, () => {
      setConfigCalls++;
    });
  } finally {
    state.isSwitching = false;
  }

  assert.equal(setConfigCalls, 0);
  assert.equal(notifications[0][0], "error");
  assert.match(notifications[0][1], /in progress/);
});

test("handleReload reports malformed config without throwing", async () => {
  fs.writeFileSync(path.join(AGENT_DIR, "model-switcher.json"), "{ not json");
  const notifications = [];
  let setConfigCalls = 0;
  const ctx = {
    ui: {
      notify(message, type) {
        notifications.push([type, message]);
      },
      setStatus() {},
    },
  };

  await handleReload({ registerProvider() {} }, ctx, () => {
    setConfigCalls++;
  });

  assert.equal(setConfigCalls, 0);
  assert.equal(notifications[0][0], "error");
  assert.match(notifications[0][1], /Failed to reload config/);
});

test("handleReload clears a dropped active model but keeps the running PID", async () => {
  writeConfigFile({
    server: { host: "127.0.0.1", port: 12345 },
    defaultModel: "new",
    models: {
      new: model({ name: "New Model", command: ["llama-server", "-m", "/models/new.gguf"] }),
    },
  });

  const state = getState();
  state.activeModelKey = "dropped";
  state.activePid = 4242;

  const notifications = [];
  const statuses = [];
  let registered = null;
  let nextConfig = null;
  const pi = {
    registerProvider(providerId, options) {
      registered = { providerId, options };
    },
  };
  const ctx = {
    ui: {
      notify(message, type) {
        notifications.push([type, message]);
      },
      setStatus(key, value) {
        statuses.push([key, value]);
      },
    },
    modelRegistry: { find: () => undefined },
  };

  try {
    await handleReload(pi, ctx, (next) => {
      nextConfig = next;
    });

    assert.ok(nextConfig);
    assert.equal(state.activeModelKey, null);
    assert.equal(state.activePid, 4242);
    assert.deepEqual(statuses.at(-1), ["llama-switch", "⚠ unlisted model running"]);
    assert.ok(
      notifications.some(
        ([type, message]) => type === "warning" && message.includes("dropped")
      )
    );
    assert.ok(registered);

    // /switch status must not crash when the active key is no longer in config.
    notifications.length = 0;
    handleStatus(nextConfig, ctx);
    assert.match(notifications.at(-1)[1], /not in current config/);
    assert.match(notifications.at(-1)[1], /4242/);
  } finally {
    state.activeModelKey = null;
    state.activePid = null;
  }
});
