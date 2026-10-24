import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { env, isDev } from "../env.ts";
import { logger } from "../log.ts";
import { authorizeUrl, exchangeCode, fetchUser } from "../github/oauth.ts";
import { clearSessionCookie, setSessionCookie } from "./auth.ts";
import type { AppEnv } from "./auth.ts";
import { HttpError } from "../errors.ts";

export const authRoutes = new Hono<AppEnv>();

const STATE_COOKIE = "cfpa_oauth_state";
const NEXT_COOKIE = "cfpa_oauth_next";
const STATE_TTL_SECONDS = 600;

const log = logger("auth");

export function safeNext(raw: string | undefined): string {
  if (!raw) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\") || raw.includes(":")) return "/";
  return raw;
}

function callbackUrl(): string {
  return `${env.PUBLIC_URL}/auth/callback`;
}

authRoutes.get("/login", (c) => {
  if (!env.GITHUB_OAUTH_CLIENT_ID || !env.GITHUB_OAUTH_CLIENT_SECRET) {
    throw new HttpError(503, "未配置 GitHub OAuth 客户端", "oauth_disabled");
  }
  const state = randomBytes(32).toString("hex");
  const next = safeNext(c.req.query("next"));
  setCookie(c, STATE_COOKIE, state, {
    httpOnly: true,
    secure: !isDev,
    sameSite: "Lax",
    path: "/auth",
    maxAge: STATE_TTL_SECONDS,
  });
  setCookie(c, NEXT_COOKIE, next, {
    httpOnly: true,
    secure: !isDev,
    sameSite: "Lax",
    path: "/auth",
    maxAge: STATE_TTL_SECONDS,
  });
  return c.redirect(authorizeUrl(state, callbackUrl()));
});

authRoutes.get("/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const expected = getCookie(c, STATE_COOKIE);
  const next = safeNext(getCookie(c, NEXT_COOKIE));
  const clearOptions = { httpOnly: true, secure: !isDev, sameSite: "Lax", path: "/auth", maxAge: 0 } as const;
  setCookie(c, STATE_COOKIE, "", clearOptions);
  setCookie(c, NEXT_COOKIE, "", clearOptions);

  if (!code || !state || !expected || state !== expected) {
    throw new HttpError(403, "OAuth state 校验失败", "invalid_state");
  }
  try {
    const token = await exchangeCode(code, callbackUrl());
    const user = await fetchUser(token);
    setSessionCookie(c, { token, login: user.login, id: user.id, avatarUrl: user.avatarUrl });
  } catch (err) {
    log.error("OAuth 登录失败", { err });
    throw new HttpError(502, "GitHub 登录失败，请重试", "oauth_failed");
  }
  return c.redirect(next);
});

authRoutes.get("/logout", (c) => {
  clearSessionCookie(c);
  return c.redirect(safeNext(c.req.query("next")));
});
