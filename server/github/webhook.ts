import { verify } from "@octokit/webhooks-methods";

export async function verifySignature(
  secret: string,
  body: string,
  signature256: string | null,
): Promise<boolean> {
  if (!secret || !signature256 || !signature256.startsWith("sha256=")) return false;
  try {
    return await verify(secret, body, signature256);
  } catch {
    return false;
  }
}
