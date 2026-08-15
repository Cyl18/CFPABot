// src/agent/pi-runtime.ts
// PiRuntime — the single anti-corruption boundary for @earendil-works/pi-coding-agent
// runtime assembly.
//
// It owns every decision about where Pi reads its runtime resources and how they
// are loaded:
//   - agentDir:    config/pi-agent (settings.json + mcp.json + skills, git-tracked)
//   - extensions:  settings.extensions (currently pi-mcp-adapter)
//   - MCP servers: config/pi-agent/mcp.json, consumed by pi-mcp-adapter
//   - skills:      config/pi-agent/skills (e.g. translation-review)
//   - transcripts: runtime/sessions/transcripts (SessionManager files)
//
// PiSessionManager must not construct Pi SDK services directly; it delegates to
// this class and keeps only session orchestration (model/tool selection, SSE,
// confirmation- and continuation-loop policy).

import { existsSync, mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  AuthStorage,
  ModelRegistry,
  SessionManager,
  createAgentSessionFromServices,
  createAgentSessionServices,
  type AgentSessionServices,
  type CreateAgentSessionFromServicesOptions,
  type CreateAgentSessionResult,
  type LoadExtensionsResult,
  type ResourceDiagnostic,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import {
  PI_SKILLS_DIR,
  SESSIONS_TRANSCRIPTS_DIR,
  ensurePiRuntimeEnv,
  piAgentDirAbs,
  sessionTranscriptAbs,
} from "../runtime-paths.js";

export type PiResourceExtension = {
  path: string;
  tools: string[];
};

export type PiResourceSkill = Pick<Skill, "name" | "filePath">;

export interface PiRuntimeResourceSnapshot {
  extensions: PiResourceExtension[];
  extensionErrors: LoadExtensionsResult["errors"];
  skills: PiResourceSkill[];
  resourceDiagnostics: ResourceDiagnostic[];
  serviceDiagnostics: AgentSessionServices["diagnostics"];
}

export interface PiTranscriptHandle {
  sessionManager: SessionManager;
  /** Present only when a new transcript file was created (caller persists it). */
  createdPath?: string;
}

export class PiRuntime {
  readonly cwd: string;
  readonly agentDir: string;
  readonly skillsDir: string;
  readonly settingsPath: string;
  readonly mcpConfigPath: string;

  constructor(
    cwd: string = process.cwd(),
    agentDir: string = piAgentDirAbs(cwd),
  ) {
    this.cwd = resolve(cwd);
    this.agentDir = resolve(agentDir);
    this.skillsDir = join(this.agentDir, "skills");
    this.settingsPath = join(this.agentDir, "settings.json");
    this.mcpConfigPath = join(this.agentDir, "mcp.json");

    // pi-mcp-adapter reads PI_CODING_AGENT_DIR directly when the extension is
    // imported; make sure the default matches this instance when no env override
    // exists (explicit overrides keep precedence).
    ensurePiRuntimeEnv(this.cwd, this.agentDir);
  }

  /**
   * Create coherent Pi runtime services for one session.
   *
   * Deliberately uses one SettingsManager for both DefaultResourceLoader and
   * AgentSession (via createAgentSessionServices). AuthStorage stays in-memory:
   * keys come from config/llm-endpoints.json and must never be persisted to
   * config/pi-agent/auth.json.
   */
  async createServices(systemPrompt: string): Promise<AgentSessionServices> {
    const authStorage = AuthStorage.inMemory();
    const modelRegistry = ModelRegistry.inMemory(authStorage);

    return createAgentSessionServices({
      cwd: this.cwd,
      agentDir: this.agentDir,
      authStorage,
      modelRegistry,
      resourceLoaderOptions: {
        // Extensions stay enabled. pi-mcp-adapter reads mcpConfigPath and
        // registers mcp/mcp_script tools from the configured MCP servers.
        // Skills/prompts/themes/context-files are intentionally agent-owned:
        // only config/pi-agent/skills is exposed, no implicit user/project discovery.
        additionalSkillPaths: [this.skillsDir],
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPrompt,
        appendSystemPrompt: [],
      },
    });
  }

  /** Thin wrapper so PiSessionManager can create AgentSession without SDK imports. */
  createAgentSession(options: CreateAgentSessionFromServicesOptions): Promise<CreateAgentSessionResult> {
    return createAgentSessionFromServices(options);
  }

  /**
   * Open an existing transcript or create a new SessionManager.
   * Enforces that persisted transcript paths stay inside runtime/sessions/transcripts.
   */
  openOrCreateSessionManager(piSessionFile?: string): PiTranscriptHandle {
    const transcriptsAbs = resolve(this.cwd, SESSIONS_TRANSCRIPTS_DIR);
    if (!existsSync(transcriptsAbs)) {
      mkdirSync(transcriptsAbs, { recursive: true });
    }

    if (piSessionFile) {
      return {
        sessionManager: SessionManager.open(sessionTranscriptAbs(piSessionFile, this.cwd)),
      };
    }

    const sessionManager = SessionManager.create(this.cwd, transcriptsAbs);
    const rawPath = sessionManager.getSessionFile();
    const fileName = rawPath
      ? basename(rawPath)
      : `${sessionManager.getSessionId()}.jsonl`;
    return {
      sessionManager,
      createdPath: `${SESSIONS_TRANSCRIPTS_DIR}/${fileName}`,
    };
  }

  /** Observable summary of what the Pi runtime actually loaded. */
  inspectResources(services: AgentSessionServices): PiRuntimeResourceSnapshot {
    const loader = services.resourceLoader;
    const extensions = loader.getExtensions();
    const skills = loader.getSkills();

    return {
      extensions: extensions.extensions.map((extension) => ({
        path: extension.path,
        tools: [...extension.tools.keys()],
      })),
      extensionErrors: extensions.errors,
      skills: skills.skills.map((skill) => ({ name: skill.name, filePath: skill.filePath })),
      resourceDiagnostics: skills.diagnostics,
      serviceDiagnostics: services.diagnostics,
    };
  }
}
