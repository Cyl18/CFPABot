// src/flows/_shared/terminology/rules.ts
// PURE: Terminology rule definitions and matching logic for Minecraft
// Chinese translation consistency checks. Rules are versioned data.
// No I/O, no globals, no side effects.

import type { TermRule, MatchedTerm } from "../types.js";

/**
 * Built-in terminology rules for Minecraft Chinese translation.
 * These represent known correct translations per CFPA conventions.
 *
 * Rules are pure data: they are defined here and surfaced via getDefaultRules()
 * so the consumer can choose whether to use defaults, extend, or replace.
 */
const DEFAULT_RULES: TermRule[] = [
  // ── Blocks / Items ──
  {
    id: "glowstone",
    pattern: "萤石",
    level: "error",
    message: "Glowstone 应译为「荧石」而非「萤石」",
    exceptions: [],
  },
  {
    id: "wither",
    pattern: "凋零",
    level: "error",
    message: "Wither 应译为「凋灵」而非「凋零」",
    exceptions: [],
  },
  {
    id: "the_nether",
    pattern: "地狱",
    level: "error",
    message: "Nether 应译为「下界」而非「地狱」",
    exceptions: [],
  },
  {
    id: "workbench",
    pattern: "工作台",
    level: "warning",
    message: "建议确认 Crafting Table 使用标准译名「工作台」而非自定义名称",
    exceptions: [],
  },
  {
    id: "lava",
    pattern: "岩浆",
    level: "warning",
    message: "Lava 官方译名为「熔岩」，确认是否为模组自定义",
    exceptions: [],
  },
  {
    id: "pink",
    pattern: "粉红色",
    level: "warning",
    message: "Pink 标准译名为「粉红色」，避免使用「粉色」",
    exceptions: [],
  },
  {
    id: "chiseled",
    pattern: "雕纹",
    level: "error",
    message: "Chiseled 应译为「雕纹」而非「雕文/錾制」",
    exceptions: [],
  },
  {
    id: "mycelium",
    pattern: "菌丝",
    level: "warning",
    message: "Mycelium 标准译名为「菌丝体」，确认是否为简称",
    exceptions: ["菌丝体", "菌丝"],
  },
  {
    id: "speed_effect",
    pattern: "速度",
    level: "warning",
    message: "Speed (状态效果) 官方译名为「迅捷」，确认上下文",
    exceptions: ["速度", "迅捷"],
  },
  {
    id: "fire_resistance",
    pattern: "抗火",
    level: "warning",
    message: "Fire Resistance 官方译名为「抗火」，确认是否为模组自定义",
    exceptions: [],
  },
  {
    id: "sculk",
    pattern: "幽匿",
    level: "warning",
    message: "Sculk 系列方块官方译名为「幽匿块/体」等，避免直接音译",
    exceptions: [],
  },
  {
    id: "slime",
    pattern: "黏液",
    level: "warning",
    message: "Slime 官方译名为「黏液」，避免使用「粘液」",
    exceptions: [],
  },
  {
    id: "piglin",
    pattern: "猪灵",
    level: "warning",
    message: "Piglin 官方译名为「猪灵」，确认拼写正确",
    exceptions: [],
  },
  {
    id: "warden",
    pattern: "监守者",
    level: "warning",
    message: "Warden 官方译名为「监守者」，确认上下文",
    exceptions: [],
  },
  {
    id: "advancement",
    pattern: "进度",
    level: "warning",
    message: "Advancement 官方译名为「进度」，避免使用「成就」",
    exceptions: [],
  },
  {
    id: "enchantment",
    pattern: "魔咒",
    level: "warning",
    message: "Enchantment 官方译名为「魔咒」，避免使用「附魔」作为名词",
    exceptions: ["附魔", "附魔书", "附魔台"],
  },
  {
    id: "creeper",
    pattern: "苦力怕",
    level: "warning",
    message: "Creeper 社区约定译名为「苦力怕」，确认上下文",
    exceptions: [],
  },
  {
    id: "spawner",
    pattern: "刷怪笼",
    level: "warning",
    message: "Spawner 官方译名为「刷怪笼」，避免使用「生成笼」",
    exceptions: [],
  },
  {
    id: "light_gray",
    pattern: "淡灰色",
    level: "error",
    message: "Light Gray 标准译名为「淡灰色」，避免使用「浅灰色」",
    exceptions: [],
  },
  {
    id: "suspicious_stew",
    pattern: "谜之炖菜",
    level: "warning",
    message: "Suspicious Stew 官方译名为「谜之炖菜」",
    exceptions: [],
  },
  {
    id: "fall_damage",
    pattern: "摔落缓冲",
    level: "warning",
    message: "Feather Falling 官方译名为「摔落缓冲」，确认上下文",
    exceptions: [],
  },
  {
    id: "clay",
    pattern: "黏土",
    level: "warning",
    message: "Clay 官方译名为「黏土」，避免使用「粘土」",
    exceptions: [],
  },
];

/**
 * Get the default set of term rules.
 * Returns a copy so callers can safely extend or replace entries.
 */
export function getDefaultRules(): TermRule[] {
  return DEFAULT_RULES.map((r) => ({ ...r }));
}

/**
 * Filter term rules by applicable game version.
 * Returns rules that have no version constraint OR whose version constraints
 * match the given game version.
 */
export function filterRulesByVersion(
  rules: TermRule[],
  gameVersion?: string,
): TermRule[] {
  if (!gameVersion) return rules;

  return rules.filter((rule) => {
    const v = rule.versions;
    if (!v) return true;

    // Version inclusion list
    if (v.include && v.include.length > 0) {
      if (!v.include.includes(gameVersion)) return false;
    }

    // Version exclusion list
    if (v.exclude && v.exclude.length > 0) {
      if (v.exclude.includes(gameVersion)) return false;
    }

    // Minimum version (simple string comparison)
    if (v.min) {
      if (compareVersions(gameVersion, v.min) < 0) return false;
    }

    return true;
  });
}

/**
 * Simple Minecraft version string comparator.
 * Compares dot-separated numeric segments.
 * Returns -1 if a < b, 0 if equal, 1 if a > b.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const aParts = a.split(".").map((s) => {
    const n = parseInt(s, 10);
    return Number.isNaN(n) ? 0 : n;
  });
  const bParts = b.split(".").map((s) => {
    const n = parseInt(s, 10);
    return Number.isNaN(n) ? 0 : n;
  });

  const maxLen = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < maxLen; i++) {
    const aVal = aParts[i] ?? 0;
    const bVal = bParts[i] ?? 0;
    if (aVal < bVal) return -1;
    if (aVal > bVal) return 1;
  }
  return 0;
}
