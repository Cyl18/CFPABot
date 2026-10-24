import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getCookie, setCookie } from "hono/cookie";
import type { Context, MiddlewareHandler } from "hono";
import { z } from "zod";
import { env, isDev } from "../env.ts";
import { logger } from "../log.ts";
import { paths } from "../paths.ts";
import { ttlCache } from "../ttl.ts";
import { gh } from "../github/client.ts";
import { HttpError } from "../errors.ts";
import type { Me } from "@cfpa/contracts/api";

export const SESSION_COOKIE = "cfpa_session";
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface AppEnv {
  Variables: {
    user: Me | null;
    token: string | null;
  };
}

export type AppContext = Context<AppEnv>;

const sessionSchema = z.object({
  token: z.string().optional(),
  login: z.string(),
  id: z.number(),
  avatarUrl: z.string(),
});

export type SessionData = z.infer<typeof sessionSchema>;

const adminCache = ttlCache<boolean>(5 * 60 * 1000, 500);

export async function isAdminLogin(login: string): Promise<boolean> {
  try {
    return await adminCache.wrap(login, () => gh.isCollaborator(login));
  } catch (err) {
    logger("auth").warn("协作者校验失败", { login, err });
    return false;
  }
}

function sessionKey(): Buffer {
  const file = join(paths.config, "secret.key");
  try {
    const hex = readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{64}$/i.test(hex)) return Buffer.from(hex, "hex");
  } catch {
    // 首次运行或文件损坏时重新生成
  }
  const hex = randomBytes(32).toString("hex");
  mkdirSync(paths.config, { recursive: true });
  writeFileSync(file, `${hex}\n`, { encoding: "utf8", mode: 0o600 });
  return Buffer.from(hex, "hex");
}

let cachedKey: Buffer | null = null;

function key(): Buffer {
  cachedKey ??= sessionKey();
  return cachedKey;
}

export function encryptSession(data: SessionData): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(data), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("hex");
}

export function decryptSession(value: string): SessionData | null {
  try {
    const raw = Buffer.from(value, "hex");
    if (raw.length < 29) return null;
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ciphertext = raw.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", key(), iv);
    decipher.setAuthTag(tag);
    const text = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    const parsed = sessionSchema.safeParse(JSON.parse(text) as unknown);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function setSessionCookie(c: AppContext, data: SessionData): void {
  setCookie(c, SESSION_COOKIE, encryptSession(data), {
    httpOnly: true,
    secure: !isDev,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

export function clearSessionCookie(c: AppContext): void {
  setCookie(c, SESSION_COOKIE, "", {
    httpOnly: true,
    secure: !isDev,
    sameSite: "Lax",
    path: "/",
    maxAge: 0,
  });
}

function devUser(login: string): Me {
  return { login, id: 0, avatarUrl: "", isAdmin: true };
}

export const authMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (isDev && env.DEV_LOGIN) {
    c.set("user", devUser(env.DEV_LOGIN));
    c.set("token", env.DEV_GITHUB_TOKEN ?? null);
    return next();
  }
  const raw = getCookie(c, SESSION_COOKIE);
  const session = raw ? decryptSession(raw) : null;
  if (!session) {
    c.set("user", null);
    c.set("token", null);
    return next();
  }
  c.set("user", {
    login: session.login,
    id: session.id,
    avatarUrl: session.avatarUrl,
    isAdmin: await isAdminLogin(session.login),
  });
  c.set("token", session.token ?? null);
  return next();
};

export function currentUser(c: AppContext): Me | null {
  return c.get("user") ?? null;
}

export async function requireAdmin(c: AppContext): Promise<Me> {
  const user = currentUser(c);
  if (!user) throw new HttpError(401, "未登录", "unauthorized");
  if (!user.isAdmin) throw new HttpError(403, "需要仓库权限", "forbidden");
  return user;
}

export function requireUserToken(c: AppContext): string {
  if (!currentUser(c)) throw new HttpError(401, "未登录", "unauthorized");
  const token = c.get("token");
  if (!token) throw new HttpError(401, "需要重新登录 GitHub 授权评论权限", "reauth");
  return token;
}
