// modrinth-client.ts
// Modrinth API v2 client — thin wrapper over @modrinth/api-client.
// All functions maintain backward-compatible signatures for callers.


import { GenericModrinthClient } from "@modrinth/api-client";
import { DEFAULT_HTTP_TIMEOUT } from "./http.js";

// Alias for the platform timer handle returned by setTimeout.
// Avoids leaking `ReturnType<typeof setTimeout>` through the module's contracts.
type TimerHandle = ReturnType<typeof setTimeout>;

// ─── Type definitions (kept for backward compatibility) ──────────────

export interface ModrinthProject {
  id: string;
  slug: string;
  title: string;
  description: string;
  projectType: ModrinthProjectType;
  clientSide: ModrinthSide;
  serverSide: ModrinthSide;
  downloads: number;
  followers: number;
  iconUrl: string | null;
  color: number | null;
  categories: string[];
  gameVersions: string[];
  loaders: string[];
  license: ModrinthLicense | null;
  team: string;
  published: string;
  updated: string;
  approved: string | null;
  status: ModrinthProjectStatus;
  sourceUrl: string | null;
  issuesUrl: string | null;
  wikiUrl: string | null;
}

export type ModrinthProjectType = "mod" | "modpack" | "resourcepack" | "shader" | "datapack" | "plugin";

export type ModrinthSide = "required" | "optional" | "unsupported" | "unknown";

export type ModrinthProjectStatus =
  | "approved"
  | "archived"
  | "rejected"
  | "draft"
  | "unlisted"
  | "processing"
  | "withheld"
  | "scheduled"
  | "private"
  | "unknown";

export interface ModrinthLicense {
  id: string;
  name: string;
  url: string | null;
}

export interface ModrinthVersion {
  id: string;
  projectId: string;
  name: string;
  versionNumber: string;
  changelog: string | null;
  datePublished: string;
  downloads: number;
  versionType: ModrinthVersionType;
  status: ModrinthVersionStatus;
  gameVersions: string[];
  loaders: string[];
  dependencies: ModrinthDependency[];
  files: ModrinthVersionFile[];
  featured: boolean;
}

export type ModrinthVersionType = "release" | "beta" | "alpha";

export type ModrinthVersionStatus = "listed" | "archived" | "draft" | "unlisted" | "scheduled" | "unknown";

export interface ModrinthDependency {
  projectId: string | null;
  versionId: string | null;
  dependencyType: ModrinthDependencyType;
}

export type ModrinthDependencyType = "required" | "optional" | "incompatible" | "embedded";

export interface ModrinthVersionFile {
  hashes: { sha1: string; sha512: string };
  url: string;
  filename: string;
  primary: boolean;
  size: number;
  fileType: ModrinthFileType | null;
}

export type ModrinthFileType = "required-resource-pack" | "optional-resource-pack";

export interface ModrinthSearchResult {
  hits: ModrinthSearchHit[];
  offset: number;
  limit: number;
  totalHits: number;
}

export interface ModrinthSearchHit {
  projectId: string;
  projectType: ModrinthProjectType;
  slug: string;
  title: string;
  description: string;
  categories: string[];
  gameVersions: string[];
  loaders: string[];
  downloads: number;
  iconUrl: string | null;
  dateCreated: string;
  dateModified: string;
}

// ─── Singleton client ────────────────────────────────────────────────

let _client: GenericModrinthClient | null = null;
function getClient(): GenericModrinthClient {
  if (!_client) {
    _client = new GenericModrinthClient({
      userAgent: "cfpa-bot",
      timeout: DEFAULT_HTTP_TIMEOUT,
    });
  }
  return _client;
}

// ─── Mapping helpers ─────────────────────────────────────────────────

interface ModrinthProjectResponse {
  id: string;
  slug: string;
  title: string;
  description: string;
  project_type: string;
  client_side: string;
  server_side: string;
  downloads: number;
  followers: number;
  icon_url?: string;
  color?: number;
  categories: string[];
  game_versions: string[];
  loaders: string[];
  license: { id: string; name: string; url?: string } | null;
  team: string;
  published: string;
  updated: string;
  approved?: string;
  status: string;
  source_url?: string;
  issues_url?: string;
  wiki_url?: string;
}

function mapProject(p: ModrinthProjectResponse): ModrinthProject {
  return {
    id: p.id,
    slug: p.slug,
    title: p.title,
    description: p.description,
    projectType: p.project_type as ModrinthProjectType,
    clientSide: p.client_side as ModrinthSide,
    serverSide: p.server_side as ModrinthSide,
    downloads: p.downloads,
    followers: p.followers,
    iconUrl: p.icon_url ?? null,
    color: p.color ?? null,
    categories: p.categories,
    gameVersions: p.game_versions,
    loaders: p.loaders,
    license: p.license ? { id: p.license.id, name: p.license.name, url: p.license.url ?? null } : null,
    team: p.team,
    published: p.published,
    updated: p.updated,
    approved: p.approved ?? null,
    status: p.status as ModrinthProjectStatus,
    sourceUrl: p.source_url ?? null,
    issuesUrl: p.issues_url ?? null,
    wikiUrl: p.wiki_url ?? null,
  };
}

// ─── Public API (backward-compatible signatures) ─────────────────────

export async function getModrinthMod(
  slug: string,
  opts: { timeoutMs?: number } = {},
): Promise<ModrinthProject> {
  const client = getClient();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_HTTP_TIMEOUT;

  // 超时定时器:race 结束后必须清理,避免定时器悬挂泄漏
  let timer: TimerHandle | undefined;
  const project = await Promise.race([
    client.labrinth.projects_v2.get(slug),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Modrinth API request timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));

  return mapProject(project);
}
