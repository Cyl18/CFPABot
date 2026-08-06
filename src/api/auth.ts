// src/api/auth.ts
// Hono middleware for cookie-based OAuth authentication via GitHub.

import type { MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { createDecipheriv, createCipheriv, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { AUTH } from "@/config.js";
import { createUserTokenGitHubClient } from "@/client/github/index.js";
import { getApiLogger } from "./flow-context.js";
import type { GitHubClient } from "@/client/github/index.js";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // GCM nonce size — NIST SP 800-38D recommends 12 bytes
/** GCM auth tag length — always 16 bytes (128-bit) regardless of IV size. */
const GCM_TAG_LENGTH = 16;

const KEY_FILE = "config/encrypt_key.txt";

/** Encrypt key loaded at bootstrap, avoids TOCTOU race from lazy init. */
let _encryptKey: string | null = null;

/**
 * Pre-load the encryption key at bootstrap. Must be called exactly once
 * before any middleware runs. Eliminates the TOCTOU race from lazy init.
 */
export function initEncryptKey(key: string): void {
  _encryptKey = key;
}

/** Read the pre-loaded encrypt key (throws if not initialized). */
export function getEncryptKey(): string {
  if (!_encryptKey) throw new Error("encrypt key not initialized — call initEncryptKey at boot");
  return _encryptKey;
}

// ---- Collaborator check cache (in-memory, TTL-based) ----
// Semantically safe: collaborator status is tied to the GitHub user identity,
// not the token. 5-minute TTL balances freshness vs API call reduction.

interface CollaboratorEntry {
  isAdmin: boolean;
  expiresAt: number;
}

const _collabCache = new Map<string, CollaboratorEntry>();
const COLLAB_CACHE_TTL_MS = 5 * 60 * 1000;
const COLLAB_CACHE_MAX = 500;

/** Check if a user is a repo collaborator, with in-memory caching. */
async function checkAdminStatus(
  client: GitHubClient,
  login: string,
): Promise<boolean> {
  // 1. Return fresh cached entry; delete if expired.
  const cached = _collabCache.get(login);
  if (cached) {
    if (cached.expiresAt > Date.now()) {
      return cached.isAdmin;
    }
    _collabCache.delete(login);
  }

  // 2. Evict when at capacity: sweep expired, then evict oldest insertion-order entries.
  if (_collabCache.size >= COLLAB_CACHE_MAX) {
    const now = Date.now();
    for (const [k, v] of _collabCache) {
      if (v.expiresAt <= now) _collabCache.delete(k);
    }
    while (_collabCache.size >= COLLAB_CACHE_MAX) {
      const first = _collabCache.keys().next();
      if (first.done) break;
      _collabCache.delete(first.value);
    }
  }

  // 3. Fetch from GitHub and cache.
  const isAdmin = await client.checkCollaborator(login);
  _collabCache.set(login, { isAdmin, expiresAt: Date.now() + COLLAB_CACHE_TTL_MS });
  return isAdmin;
}

/**
 * Encrypt an OAuth token with AES-256-GCM using the given hex key.
 * Layout: [authTag (16) | iv (IV_LENGTH) | ciphertext] — tag first so decryption reads it first.
 * A random IV (nonce) is generated per encryption.
 */
export function encryptOAuthToken(token: string, key: string): string {
  const keyBuffer = Buffer.from(key, "hex");
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, keyBuffer, iv);
  const encrypted = Buffer.concat([iv, cipher.update(token, "utf-8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([authTag, encrypted]).toString("hex");
}

/**
 * Decrypt an AES-256-GCM hex-encrypted value using the given hex key.
 * Layout: [authTag (16) | iv (IV_LENGTH) | ciphertext] — tag is verified on final().
 * The auth tag is always 16 bytes; iv length is determined by IV_LENGTH.
 */
export function decryptOAuthToken(encrypted: string, key: string): string {
  const keyBuffer = Buffer.from(key, "hex");
  const encryptedBuffer = Buffer.from(encrypted, "hex");
  const authTag = encryptedBuffer.subarray(0, GCM_TAG_LENGTH);
  const iv = encryptedBuffer.subarray(GCM_TAG_LENGTH, GCM_TAG_LENGTH + IV_LENGTH);
  const ciphertext = encryptedBuffer.subarray(GCM_TAG_LENGTH + IV_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, keyBuffer, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf-8");
}

/**
 * Read the encryption key from `config/encrypt_key.txt`.
 * If the file does not exist, generate a random 32-byte hex key and persist it.
 * Should be called once at bootstrap via `initEncryptKey()`.
 */
export async function getOrCreateEncryptKey(): Promise<string> {
  try {
    const key = (await readFile(KEY_FILE, "utf-8")).trim();
    if (key.length > 0) return key;
  } catch {
    // file missing or empty — generate new key
  }

  const key = randomBytes(32).toString("hex");
  await writeFile(KEY_FILE, key, "utf-8");
  return key;
}

/**
 * Middleware that reads the encrypted OAuth cookie, decrypts it, fetches the
 * authenticated GitHub user, and attaches the user info + token to the request
 * context. If the token is expired or the API call fails, clears the cookie.
 *
 * Must be registered before routes that call `c.get("user")` or `c.get("oauthToken")`.
 */
export const authMiddleware: MiddlewareHandler = async (c, next) => {
  // Dev mode: auto-grant admin, skip OAuth/collaborator checks.
  if (process.env.ASPNETCORE_ENVIRONMENT === "Development") {
    const devToken = process.env.GITHUB_OAUTH_TOKEN;
    if (devToken) {
      try {
        const client = createUserTokenGitHubClient(devToken, getApiLogger());
        const user = await client.getUser();
        c.set("user", { ...user, avatar: "" });
        c.set("oauthToken", devToken);
        c.set("isAdmin", true);
        c.set("isContributor", true);
      } catch (e) {
        // Token present but verification failed — don't silently grant admin.
        // Fall back to no-user mode so misconfiguration is visible.
        getApiLogger().warn({ err: String(e) }, "[auth][dev]: GITHUB_OAUTH_TOKEN 验证失败，清除 dev 登录");
        c.set("user", null);
        c.set("oauthToken", null);
        c.set("isAdmin", false);
        c.set("isContributor", false);
      }
    }
    return next();
  }
  
  const encrypted = getCookie(c, AUTH.OAUTH_TOKEN_COOKIE_NAME);
  if (!encrypted) {
    c.set("user", null);
    c.set("isAdmin", false);
    c.set("isContributor", false);
    return next();
  }
  
  try {
    const key = getEncryptKey();
    const token = decryptOAuthToken(encrypted, key);
  
    // Validate token by fetching the authenticated user
    const client = createUserTokenGitHubClient(token, getApiLogger());
    const user = await client.getUser();
    c.set("user", user);
    c.set("oauthToken", token);
  
    // Check admin status via repo collaborator membership — uses in-memory
    // cache with 5-minute TTL to reduce repeated API calls for the same user.
    c.set("isAdmin", await checkAdminStatus(client, user.login));
    c.set("isContributor", false);
  } catch (e) {
    getApiLogger().warn({ err: String(e) }, "[auth]: OAuth token 验证失败，清除 cookie");
    c.set("user", null);
    c.set("oauthToken", null);
    c.set("isAdmin", false);
    c.set("isContributor", false);
    setCookie(c, AUTH.OAUTH_TOKEN_COOKIE_NAME, "", {
      httpOnly: true,
      sameSite: "Lax",
      // Match oauth.ts: Secure cookies break on http://localhost in Development
      secure: process.env.ASPNETCORE_ENVIRONMENT !== "Development",
      path: "/",
      maxAge: 0,
    });
  }
  
  return next();
};

/**
 * Middleware that rejects unauthenticated requests with a 401 response.
 * Must be registered after `authMiddleware`.
 */
export const requireAuth: MiddlewareHandler = async (c, next) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  return next();
};

/**
 * Middleware that rejects if the user lacks repo write access (isAdmin = collaborator/owner/org-member with push).
 * Must be registered after `authMiddleware`.
 */
export const requireAdmin: MiddlewareHandler = async (c, next) => {
  const isAdmin = c.get("isAdmin");
  if (!isAdmin) {
    return c.json({ error: "Forbidden" }, 403);
  }
  return next();
};

