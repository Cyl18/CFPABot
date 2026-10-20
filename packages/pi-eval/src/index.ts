import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { evalTool } from "./tool.ts";

export interface EvalExtensionConfig {
  image?: string;
}

export function evalExtension(config: EvalExtensionConfig = {}): ExtensionFactory {
  const image = config.image ?? "cfpa-eval:latest";
  return (pi: ExtensionAPI) => {
    pi.registerTool(evalTool({ image }));
  };
}

export default evalExtension();

export { runEval } from "./eval.ts";
export type { EvalFiles, EvalInput, EvalOptions, EvalResult } from "./eval.ts";
