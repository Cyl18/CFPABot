import type { LangFormat, Locale } from "@cfpa/review-core/domain/path";

export interface ModDep {
  id: string;
  slug: string;
  name: string;
  url: string;
  iconUrl?: string;
  sourceUrl?: string;
}

export interface ModInfo {
  provider: "curseforge" | "modrinth";
  id: string;
  slug: string;
  name: string;
  url: string;
  iconUrl?: string;
  sourceUrl?: string;
  allowDistribution: boolean;
  isMCreator: boolean;
  dependencies: ModDep[];
}

export interface ModFile {
  provider: "curseforge" | "modrinth";
  id: string;
  fileName: string;
  url: string | null;
  gameVersions: string[];
  loaders: string[];
  date: string;
}

export interface JarLang {
  path: string;
  domain: string;
  locale: Locale;
  format: LangFormat;
  content: string;
}

export interface JarLangLoose {
  path: string;
  name: string;
  locale: Locale;
  format: LangFormat;
  content: string;
}

export interface JarInfo {
  file: ModFile;
  fetchedAt: string;
  domains: string[];
  assetDirs: string[];
  langDirs: string[];
  lang: JarLang[];
  langLoose: JarLangLoose[];
}
