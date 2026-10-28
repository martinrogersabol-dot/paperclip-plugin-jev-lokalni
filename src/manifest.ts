import { definePlugin } from "@paperclipai/plugin-sdk";
import {
  DATA_KEYS,
  PLUGIN_ID,
  PLUGIN_VERSION,
} from "./constants";
import { analyzeIssue } from "./worker";
import { decideBrowserAction } from "./browser";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { BrowserConfig } from "./browser";
import type { PluginConfig } from "./worker";

const config: PluginConfig = {
  localEndpoint: "http://127.0.0.1:8012/v1",
  model: "ornith-1.5-35b-a3b-splash",
};

const browserConfig: BrowserConfig = {
  model: "ornith-1.5-35b-a3b-splash",
  mode: "observe",
  confidenceThreshold: 0.85,
  allowedOrigins: ["http://127.0.0.1:3100", "http://localhost:3100"],
  includePageText: true,
};

export default definePlugin({
  id: PLUGIN_ID,
  name: "Jev Triage (lokální)",
  description:
    "Triage a rozhodování o akcí přes lokální model bez třetí strany. " +
    "Žádná odchozí volání mimo localhost, žádné API klíče — výchozí endpoint je http://127.0.0.1:8012/v1.",
  pluginVersion: PLUGIN_VERSION,
  version: PLUGIN_VERSION,
  author: "andrewdeng318 (adaptace tym-vyvojar)",
  license: "MIT",
  capabilities: {
    // Žádná odchozí volání mimo localhost a žádné čtení secretů.
    secrets: { capabilities: [], capabilitiesRead: false },
  },
  config: config,
  defaultConfig: config,
  configSchema: {
    type: "object",
    properties: {
      localEndpoint: {
        type: "string",
        title: "Lokální endpoint",
        description: "OpenAI-kompatibilní endpoint lokálního modelu (výchoze :8012/v1).",
      },
      model: {
        type: "string",
        title: "Model",
        description: "Model pro lokální server (výchoze ornith-1.5-35b-a3b-splash).",
      },
    },
    required: ["localEndpoint", "model"],
    additionalProperties: false,
  },
  dataKeys: Object.values(DATA_KEYS),
  actions: {
    [ACTIONS.analyzeIssue]: {
      name: ACTIONS.analyzeIssue,
      displayName: "Analyze issue",
      description: "Analyzuje issue a určí majitele, prioritu a typ pomocí lokálního modelu.",
      actionType: "task",
      inputs: [
        {
          type: "object",
          name: "issueContext",
          title: "Issue context",
          config: { "context-scope": "all" },
        },
      ],
      outputs: [
        { type: "string", name: "content", displayName: "Content" },
        { type: "object", name: "data", displayName: "Data" },
      ],
      run: (ctx: PluginContext) => analyzeIssue(ctx),
      defaultAutomation: {
        mode: "manual",
      },
    },
  },
  toolCalls: [
    {
      id: TOOL_NAMES.decideBrowserAction,
      name: TOOL_NAMES.decideBrowserAction,
      displayName: "Decide browser action",
      description:
        "Z rozhodnutí lokálního modelu provede browser akci. Žádná odchozí adresa mimo localhost.",
      inputs: [
        { type: "object", name: "input", displayName: "Input" },
        { type: "object", name: "params", displayName: "Params" },
      ],
      outputs: [
        { type: "string", name: "content", displayName: "Content" },
        { type: "object", name: "data", displayName: "Data" },
      ],
      run: (ctx: PluginContext) => decideBrowserAction(ctx),
      defaultAutomation: {
        mode: "manual",
      },
    },
  ],
  toolCallConfigSchema: {
    type: "object",
    properties: {
      model: { type: "string" },
      mode: { type: "string" },
      confidenceThreshold: { type: "number" },
    },
    required: ["model", "mode", "confidenceThreshold"],
    additionalProperties: false,
  },
  toolCallDefaultConfig: {
    model: "ornith-1.5-35b-a3b-splash",
    mode: "observe",
    confidenceThreshold: 0.85,
  },
  toolCallSecretRef: [],
});
