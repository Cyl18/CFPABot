import { Hono } from "hono";
import type { Context } from "hono";
import { env } from "../env.ts";
import { logger } from "../log.ts";
import { verifySignature } from "../github/webhook.ts";
import { handleWebhook } from "../bot/index.ts";
import { HttpError, MAX_BODY_BYTES } from "./errors.ts";
import type { AppEnv } from "./auth.ts";

export const webhookRoutes = new Hono<AppEnv>();

const log = logger("webhook");
const DELIVERY_TTL_MS = 10 * 60 * 1000;
const deliveries = new Map<string, number>();

function pruneDeliveries(now: number): void {
  if (deliveries.size < 500) return;
  for (const [id, at] of deliveries) {
    if (now - at > DELIVERY_TTL_MS) deliveries.delete(id);
  }
}

const handleWebhookRequest = async (c: Context<AppEnv>) => {
  const secret = env.GITHUB_WEBHOOK_SECRET;
  if (!secret) throw new HttpError(503, "未配置 GITHUB_WEBHOOK_SECRET", "webhook_disabled");

  const declared = Number(c.req.header("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new HttpError(413, "请求体过大", "body_too_large");

  const body = await c.req.text();
  if (body.length > MAX_BODY_BYTES) throw new HttpError(413, "请求体过大", "body_too_large");

  const signature = c.req.header("x-hub-signature-256") ?? null;
  if (!(await verifySignature(secret, body, signature))) {
    throw new HttpError(401, "签名校验失败", "invalid_signature");
  }

  const now = Date.now();
  pruneDeliveries(now);
  const delivery = c.req.header("x-github-delivery");
  if (delivery) {
    if (deliveries.has(delivery)) return c.json({ ok: true }, 200);
    deliveries.set(delivery, now);
  }

  const event = c.req.header("x-github-event");
  if (!event) throw new HttpError(400, "缺少 x-github-event 请求头", "invalid_event");

  let payload: unknown;
  try {
    payload = JSON.parse(body) as unknown;
  } catch {
    throw new HttpError(400, "请求体不是有效的 JSON", "invalid_json");
  }

  void handleWebhook(event, payload).catch((err: unknown) => log.error("Webhook 处理失败", { event, err }));
  return c.json({ ok: true }, 202);
};

webhookRoutes.post("/webhook", handleWebhookRequest);
webhookRoutes.post("/WebhookListener", handleWebhookRequest);
