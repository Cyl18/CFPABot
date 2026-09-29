import { z } from "zod";
import { env } from "../env.ts";

const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";

const tokenSchema = z.object({
  access_token: z.string().optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
});

const userSchema = z.object({
  login: z.string(),
  id: z.number(),
  avatar_url: z.string().default(""),
});

function credentials(): { id: string; secret: string } {
  const id = env.GITHUB_OAUTH_CLIENT_ID;
  const secret = env.GITHUB_OAUTH_CLIENT_SECRET;
  if (!id || !secret) throw new Error("未配置 GITHUB_OAUTH_CLIENT_ID / GITHUB_OAUTH_CLIENT_SECRET");
  return { id, secret };
}

export function authorizeUrl(state: string, redirectUri: string): string {
  const { id } = credentials();
  const params = new URLSearchParams({
    client_id: id,
    redirect_uri: redirectUri,
    scope: "read:user",
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

export async function exchangeCode(code: string, redirectUri: string): Promise<string> {
  const { id, secret } = credentials();
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "user-agent": "CFPAAgent2" },
    body: JSON.stringify({ client_id: id, client_secret: secret, code, redirect_uri: redirectUri }),
  });
  if (!res.ok) throw new Error(`GitHub OAuth 令牌交换失败: HTTP ${res.status}`);
  const parsed = tokenSchema.safeParse(await res.json());
  if (!parsed.success) throw new Error("GitHub OAuth 返回了无法解析的响应");
  const token = parsed.data.access_token;
  if (!token) throw new Error(parsed.data.error_description ?? parsed.data.error ?? "GitHub OAuth 未返回 access_token");
  return token;
}

export async function fetchUser(token: string): Promise<{ login: string; id: number; avatarUrl: string }> {
  const res = await fetch(USER_URL, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "CFPAAgent2",
    },
  });
  if (!res.ok) throw new Error(`获取 GitHub 用户信息失败: HTTP ${res.status}`);
  const parsed = userSchema.safeParse(await res.json());
  if (!parsed.success) throw new Error("GitHub 用户信息格式错误");
  return { login: parsed.data.login, id: parsed.data.id, avatarUrl: parsed.data.avatar_url };
}
