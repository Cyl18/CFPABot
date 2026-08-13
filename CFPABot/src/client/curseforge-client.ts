// curseforge-client.ts
// CurseForge API v1 client — thin wrapper over @xmcl/curseforge.
// All functions maintain backward-compatible signatures for callers.


import { CurseforgeV1Client, type Mod, type File } from "@xmcl/curseforge";
import { DEFAULT_HTTP_TIMEOUT } from "./http.js";

// ─── Type definitions (kept for backward compatibility) ──────────────

export interface CFAddon {
  id: number;
  name: string;
  slug: string;
  summary: string;
  websiteUrl: string;
  thumbnailUrl: string | null;
  authors: CFAuthor[];
  categories: CFCategory[];
  links: CFLink[];
  dateCreated: string;
  dateModified: string;
  dateReleased: string;
  gameId: number;
  gameName: string;
  downloadCount: number;
  latestFiles: CFFile[];
}

export interface CFAuthor {
  id: number;
  name: string;
  url: string;
}

export interface CFCategory {
  id: number;
  gameId: number;
  name: string;
  slug: string;
  url: string;
}

export interface CFLink {
  platform: string;
  platformId: number;
  label: string;
  url: string;
}

export interface CFFile {
  id: number;
  gameId: number;
  modId: number;
  isAvailable: boolean;
  displayName: string;
  fileName: string;
  fileDate: string;
  fileLength: number;
  releaseType: ReleaseType;
  fileStatus: FileStatus;
  downloadUrl: string | null;
  gameVersions: string[];
  dependencies: CFDependency[];
  modules: CFModule[];
  isServerPack: boolean;
}

export type ReleaseType = "release" | "beta" | "alpha";

export type FileStatus =
  | "processing"
  | "changesRequired"
  | "underReview"
  | "approved"
  | "rejected"
  | "malwareDetected"
  | "deleted"
  | "archived"
  | "testing";

export interface CFDependency {
  modId: number;
  fileId: number | null;
  relationType: DependencyRelation;
}

export type DependencyRelation =
  | "embeddedLibrary"
  | "incompatible"
  | "optionalDependency"
  | "requiredDependency"
  | "tool"
  | "include"
  | "weakDependency";

export interface CFModule {
  name: string;
  fingerprint: number;
}

export interface CFPagination {
  index: number;
  pageSize: number;
  resultCount: number;
  totalCount: number;
}

export interface CFSearchResult {
  data: CFAddon[];
  pagination: CFPagination;
}

// ─── Singleton client ────────────────────────────────────────────────

let _client: CurseforgeV1Client | null = null;

function getClient(): CurseforgeV1Client {
  if (!_client) {
    const apiKey = process.env.CF_API_KEY;
    if (!apiKey) {
      throw new Error("CF_API_KEY environment variable is required for CurseForge API calls");
    }
    _client = new CurseforgeV1Client(apiKey, {
      headers: { "User-Agent": "cfpa-bot", Accept: "application/json" },
    });
  }
  return _client;
}

// ─── Mapping helpers ─────────────────────────────────────────────────

function mapModToCFAddon(mod: Mod): CFAddon {
  return {
    id: mod.id,
    name: mod.name,
    slug: mod.slug,
    summary: mod.summary,
    websiteUrl: mod.links?.websiteUrl ?? "",
    thumbnailUrl: mod.logo?.thumbnailUrl ?? null,
    authors: mod.authors.map((a) => ({
      id: a.id,
      name: a.name,
      url: a.url,
    })),
    categories: mod.categories.map((c) => ({
      id: c.id,
      gameId: c.gameId,
      name: c.name,
      slug: c.slug,
      url: c.url,
    })),
    links: [],
    dateCreated: mod.dateCreated,
    dateModified: mod.dateModified,
    dateReleased: mod.dateReleased,
    gameId: mod.gameId,
    gameName: "Minecraft",
    downloadCount: mod.downloadCount,
    latestFiles: mod.latestFiles.map(mapFileToCFFile),
  };
}

function mapFileToCFFile(file: File): CFFile {
  return {
    id: file.id,
    gameId: file.gameId,
    modId: file.modId,
    isAvailable: file.isAvailable,
    displayName: file.displayName,
    fileName: file.fileName,
    fileDate: file.fileDate,
    fileLength: file.fileLength,
    releaseType: mapReleaseType(file.releaseType),
    fileStatus: mapFileStatus(file.fileStatus),
    downloadUrl: file.downloadUrl ?? null,
    gameVersions: file.gameVersions,
    dependencies: file.dependencies.map((d) => ({
      modId: d.modId,
      fileId: null,
      relationType: mapRelationType(d.relationType),
    })),
    modules: file.modules.map((m) => ({
      name: m.name,
      fingerprint: m.fingerprint,
    })),
    isServerPack: false,
  };
}

function mapReleaseType(value: number): ReleaseType {
  if (value === 2) return "beta";
  if (value === 3) return "alpha";
  return "release";
}

function mapFileStatus(value: number): FileStatus {
  switch (value) {
    case 1: return "processing";
    case 2: return "changesRequired";
    case 3: return "underReview";
    case 4: return "approved";
    case 5: return "rejected";
    case 6: return "malwareDetected";
    case 7: return "deleted";
    case 8: return "archived";
    case 9: return "testing";
    default: return "processing";
  }
}

function mapRelationType(value: number): DependencyRelation {
  switch (value) {
    case 1: return "embeddedLibrary";
    case 2: return "optionalDependency";
    case 3: return "requiredDependency";
    case 4: return "tool";
    case 5: return "incompatible";
    case 6: return "include";
    default: return "optionalDependency";
  }
}

// ─── Public API (backward-compatible signatures) ─────────────────────

export async function findCurseForgeAddon(
  slugOrId: string | number,
  opts: { timeoutMs?: number } = {},
): Promise<CFAddon> {
  const client = getClient();
  const signal = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_HTTP_TIMEOUT);

  if (typeof slugOrId === "number") {
    const mod = await client.getMod(slugOrId, signal);
    return mapModToCFAddon(mod);
  }

  const result = await client.searchMods({ slug: slugOrId, gameId: 432 }, signal);
  const exact = result.data.find((mod) => mod.slug === slugOrId);
  if (!exact) {
    throw new Error(`CurseForge addon not found for slug: ${slugOrId}`);
  }
  return mapModToCFAddon(exact);
}

export async function findCurseForgeAddonsByIds(
  ids: number[],
  opts: { timeoutMs?: number } = {},
): Promise<CFAddon[]> {
  if (ids.length === 0) return [];
  const client = getClient();
  const mods = await client.getMods(ids, AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_HTTP_TIMEOUT));
  return mods.map(mapModToCFAddon);
}


export async function getCurseForgeEnFile(
  addon: CFAddon,
  version: string,
  opts: { timeoutMs?: number } = {},
): Promise<string> {
  const matchingFile = addon.latestFiles.find(
    (f) => f.gameVersions.includes(version) && f.isAvailable,
  );

  if (!matchingFile) {
    throw new Error(
      `No available file for CurseForge addon ${addon.slug} matching version ${version}`,
    );
  }

  const downloadUrl = matchingFile.downloadUrl;
  if (!downloadUrl) {
    throw new Error(`No download URL for file ${matchingFile.id} of addon ${addon.slug}`);
  }

  const response = await fetch(downloadUrl, {
    headers: { "User-Agent": "cfpa-bot" },
    redirect: "follow",
    signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_HTTP_TIMEOUT),
  });

  if (!response.ok) {
    throw new Error(`Failed to download CurseForge file: HTTP ${response.status}`);
  }

  return response.text();
}

export async function downloadCurseForgeFile(url: string): Promise<Response> {
  const response = await fetch(url, {
    headers: { "User-Agent": "cfpa-bot" },
    redirect: "follow",
    signal: AbortSignal.timeout(DEFAULT_HTTP_TIMEOUT),
  });
  if (!response.ok) {
    throw new Error(`Failed to download CurseForge file: HTTP ${response.status}`);
  }
  return response;
}
