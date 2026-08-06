// src/bootstrap.ts
// Server bootstrap: creates all deps, wires them together, starts Bun.serve.
//
// This file is now a thin orchestrator over src/bootstrap/*. Individual
// concerns (directory setup, dep creation, flow registry, app creation,
// server startup) each live in their own module.
//
// Backward-compatible exports preserved:
//   - bootstrap(config, logger) — the main entry point
//   - createCSRFOptions(environment) — exported for tests + direct use

export { bootstrap } from "./bootstrap/orchestrator.js";
export { createCSRFOptions } from "./bootstrap/app.js";
