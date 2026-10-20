import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { type } from "@oh-my-pi/omptype";
import { lookupTerm } from "../../domain/terms.ts";
import { glossaryLookup } from "../glossary.ts";
import { glossaryTerms } from "../../domain/glossary.ts";
import { jsonResult } from "../result.ts";

const GLOSSARY_PARAMS = type({
  query: type("string").describe("要查的英文词或短语"),
  "limit?": type("number").describe("每个来源最多返回条数，默认 10，上限 50"),
});

export function glossaryTool(): AgentTool<typeof GLOSSARY_PARAMS> {
  return {
    name: "glossary",
    label: "术语查询",
    description: "查询原版术语与外部词典；用法见 help://tools/glossary。",
    parameters: GLOSSARY_PARAMS,
    execute: async (_toolCallId, params) => {
      const limit = Math.min(50, Math.max(1, Math.floor(params.limit ?? 10)));
      const terms = await glossaryTerms();
      const vanilla = terms ? lookupTerm(terms, params.query, limit) : [];
      const external = await glossaryLookup(params.query, limit);
      return jsonResult({
        vanilla,
        glossary: external.items,
        ...(external.note ? { note: external.note } : {}),
        ...(terms ? {} : { vanillaNote: "原版术语表未加载" }),
      });
    },
  };
}
