// src/api/oauth.ts
// Hono router for GitHub OAuth authentication (cookie-based, no Bearer header).

import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { randomBytes } from "node:crypto";
import { encryptOAuthToken, getEncryptKey } from "./auth.js";
import { getApiLogger } from "./flow-context.js";
import { AUTH } from "@/config.js";
import { exchangeOAuthCode } from "@/client/github/index.js";

const oauth = new Hono();

const STATE_COOKIE_NAME = "oauth-state";
const RETURN_COOKIE_NAME = "oauth-return";
const STATE_TTL_SECONDS = 600; // 10 minutes

/**
 * Resolve a safe post-login redirect target.
 * Only localhost / 127.0.0.1 absolute origins are accepted from cookies/referer;
 * anything else falls back to same-origin "/".
 */
function resolveReturnTo(raw: string | undefined): string {
  if (!raw) return "/";
  if (raw === "/") return "/";
  try {
    const u = new URL(raw);
    if (
      (u.hostname === "localhost" || u.hostname === "127.0.0.1") &&
      (u.protocol === "http:" || u.protocol === "https:")
    ) {
      return `${u.origin}/`;
    }
  } catch {
    // ignore invalid URLs
  }
  return "/";
}

/**
 * GET /github
 * Redirect the user to GitHub's OAuth authorization page.
 * Generates a random state parameter to prevent CSRF attacks.
 */
oauth.get("/github", (c) => {
  const state = randomBytes(32).toString("hex");
  const secure = process.env.ASPNETCORE_ENVIRONMENT !== "Development";
  setCookie(c, STATE_COOKIE_NAME, state, {
    httpOnly: true,
    secure,
    sameSite: "Strict",
    path: "/api/oauth",
    maxAge: STATE_TTL_SECONDS,
  });

  // Remember where the browser started so callback can bounce back to Vite (5173/5174)
  // instead of the backend origin (8080) or a production host.
  const returnTo = resolveReturnTo(c.req.header("referer") ?? undefined);
  setCookie(c, RETURN_COOKIE_NAME, returnTo, {
    httpOnly: true,
    secure,
    sameSite: "Lax",
    path: "/api/oauth",
    maxAge: STATE_TTL_SECONDS,
  });

  const url = `${AUTH.OAUTH_AUTHORIZE_URL}?client_id=${AUTH.OAUTH_CLIENT_ID}&scope=${AUTH.OAUTH_SCOPES}&state=${state}`;
  return c.redirect(url);
});

/**
 * GET /callback
 * Handle the OAuth callback: verify state parameter (CSRF protection),
 * exchange the temporary code for an access token, encrypt it,
 * persist it in a cookie, then redirect to the frontend.
 */
oauth.get("/callback", async (c) => {
  const code = c.req.query("code");
  if (!code) {
    return c.html("<h1>Missing code parameter</h1><p>GitHub did not provide an authorization code.</p>", 400);
  }

  // Verify state parameter to prevent CSRF
  const returnedState = c.req.query("state");
  const expectedState = getCookie(c, STATE_COOKIE_NAME);
  if (!returnedState || !expectedState || returnedState !== expectedState) {
    return c.html("<h1>Invalid state parameter</h1><p>Possible CSRF attack. Please try again.</p>", 403);
  }

  const secure = process.env.ASPNETCORE_ENVIRONMENT !== "Development";
  const returnTo = resolveReturnTo(getCookie(c, RETURN_COOKIE_NAME));

  // Clear one-shot OAuth cookies after use
  setCookie(c, STATE_COOKIE_NAME, "", {
    httpOnly: true,
    secure,
    sameSite: "Strict",
    path: "/api/oauth",
    maxAge: 0,
  });
  setCookie(c, RETURN_COOKIE_NAME, "", {
    httpOnly: true,
    secure,
    sameSite: "Lax",
    path: "/api/oauth",
    maxAge: 0,
  });

  try {
    // Exchange the code for an access token
    // Throws on failure — no need to check error_description
    const tokenData = await exchangeOAuthCode(code);

    // Encrypt the token and store it in a cookie
    const key = getEncryptKey();
    const encrypted = encryptOAuthToken(tokenData.accessToken, key);

    const maxAge = AUTH.COOKIE_MAX_AGE_DAYS * 24 * 60 * 60;
    setCookie(c, AUTH.OAUTH_TOKEN_COOKIE_NAME, encrypted, {
      httpOnly: true,
      secure,
      sameSite: "Lax",
      path: "/",
      maxAge,
    });

    return c.redirect(returnTo);
  } catch (err) {
    getApiLogger().error({ err: String(err) }, "OAuth callback failed");
    return c.html("<h1>认证失败</h1><p>GitHub OAuth 认证过程中发生错误，请重试。</p>", 500);
  }
});

/**
 * GET /signout
 * Clear the OAuth cookie and redirect to the frontend.
 */
oauth.get("/signout", (c) => {
  setCookie(c, AUTH.OAUTH_TOKEN_COOKIE_NAME, "", {
    httpOnly: true,
    secure: process.env.ASPNETCORE_ENVIRONMENT !== "Development",
    sameSite: "Lax",
    path: "/",
    maxAge: 0,
  });
  // Prefer bouncing back to the page the user signed out from (Vite dev origin).
  const returnTo = resolveReturnTo(c.req.header("referer") ?? undefined);
  return c.redirect(returnTo);
});

export { oauth };

