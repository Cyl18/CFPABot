import { existsSync } from "node:fs";
import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { evalExtension } from "@cfpa/pi-eval";
import todoExtension from "@capdiem/pi-todo/index.min.js";
import webAccess from "pi-web-access/dist/index.js";
import { env } from "../env.ts";
import { paths } from "../paths.ts";
import { modelsCollection } from "./llm.ts";
import type { SessionRecord } from "./sessions.ts";

export async function createModelRuntime(model: Model<Api>, apiKey: string | undefined): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
  const collection = await modelsCollection();
  for (const provider of collection.getProviders()) runtime.registerNativeProvider(provider);
  if (apiKey) await runtime.setRuntimeApiKey(model.provider, apiKey);
  return runtime;
}

export async function createResourceLoader(systemPrompt: string): Promise<ResourceLoader> {
  const loader = new DefaultResourceLoader({
    cwd: paths.root,
    agentDir: paths.piAgent,
    settingsManager: SettingsManager.inMemory(),
    extensionFactories: [evalExtension({ image: env.EVAL_DOCKER_IMAGE }), todoExtension, webAccess],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt,
  });
  await loader.reload();
  return loader;
}

export async function openSessionManager(record: SessionRecord): Promise<SessionManager> {
  if (record.sessionFile && existsSync(record.sessionFile)) {
    return SessionManager.open(record.sessionFile, paths.sessions, paths.root);
  }
  const found = SessionManager.findById(paths.root, record.meta.id, paths.sessions);
  if (found) {
    record.sessionFile = found;
    return SessionManager.open(found, paths.sessions, paths.root);
  }
  const manager = SessionManager.create(paths.root, paths.sessions, { id: record.meta.id });
  const file = manager.getSessionFile();
  if (!file) throw new Error("无法创建会话文件。");
  record.sessionFile = file;
  return manager;
}

export function sessionMessages(record: SessionRecord): AgentMessage[] {
  if (!record.sessionFile || !existsSync(record.sessionFile)) return [];
  try {
    const manager = SessionManager.open(record.sessionFile, paths.sessions, paths.root);
    return manager.buildSessionProjection().messages;
  } catch {
    return [];
  }
}
