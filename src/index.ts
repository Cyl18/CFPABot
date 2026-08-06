// src/index.ts
// Entry point: creates config + logger, then delegates to bootstrap().

import { loadEntryConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { bootstrap } from "./bootstrap.js";

const main = async () => {
  const config = await loadEntryConfig();
  const logger = createLogger(config);

  process.on("unhandledRejection", (reason) => {
    logger.error(
      { err: reason instanceof Error ? reason : new Error(String(reason)) },
      "未处理的 Promise 拒绝",
    );
    // Short delay to let the logger flush before exiting
    setTimeout(() => process.exit(1), 200);
  });

  bootstrap(config, logger).catch((err) => {
    logger.error({ err: String(err) }, "启动失败");
    process.exit(1);
  });
};

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
