import { Hono } from "hono";
import { checkReportPath } from "../paths.ts";
import { prdata } from "../prdata.ts";
import type { AppEnv } from "./auth.ts";
import { HttpError } from "./errors.ts";

export const utilsRoutes = new Hono<AppEnv>();

utilsRoutes.get("/Utils/PathValidation", async (c) => {
  const pr = Number(c.req.query("pr") ?? "");
  if (!Number.isInteger(pr) || pr <= 0) throw new HttpError(400, "PR 编号无效", "invalid_pr");
  const { files } = await prdata.files(pr);
  const lines = files
    .filter((file) => file.path.includes("lang") && [...file.path].some((ch) => !/[0-9A-Za-z_\-./]/.test(ch)))
    .map((file) => `${file.path}\n`);
  return c.text(lines.join(""), 200, { "Content-Type": "text/plain; charset=utf-8" });
});

utilsRoutes.get("/Utils/Report/:pr/:sha", async (c) => {
  const pr = Number(c.req.param("pr"));
  const sha = c.req.param("sha");
  if (!Number.isInteger(pr) || pr <= 0 || !/^[0-9a-f]{7}$/i.test(sha)) {
    throw new HttpError(400, "参数无效", "invalid_param");
  }
  const text = await Bun.file(checkReportPath(pr, sha))
    .text()
    .catch(() => null);
  if (text === null) return c.text("", 404);
  return c.text(text, 200, { "Content-Type": "text/plain; charset=utf-8" });
});
