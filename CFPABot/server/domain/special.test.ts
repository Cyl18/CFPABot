import { describe, expect, test } from "bun:test";
import type { PrFile } from "@cfpa/contracts/api";
import type { SpecialPlan } from "./special.ts";
import { planAtHead, planSpecial, resolveDerived, resolveSpecial } from "./special.ts";

const ROOT = "projects/assets/demo/1.20.1/assets/demo/guide";
const EN = `${ROOT}/concepts.md`;
const ZH = `${ROOT}/zh_cn/concepts.md`;

function file(path: string, status: PrFile["status"], previousPath?: string): PrFile {
  return { path, status, additions: 0, deletions: 0, ...(previousPath === undefined ? {} : { previousPath }) };
}

function first(plans: readonly SpecialPlan[]): SpecialPlan {
  const [plan] = plans;
  if (plan === undefined) throw new Error("缺少计划");
  return plan;
}

function pairWhere(plans: readonly SpecialPlan[], match: (plan: Extract<SpecialPlan, { kind: "pair" }>) => boolean) {
  const plan = plans.find((item): item is Extract<SpecialPlan, { kind: "pair" }> => item.kind === "pair" && match(item));
  if (plan === undefined) throw new Error("缺少配对计划");
  return plan;
}

describe("special head 过滤", () => {
  test("英文改名离开、中文删除的组不再产出", () => {
    const plans = planSpecial([
      file(`${ROOT}/concepts2.md`, "renamed", EN),
      file(`${ROOT}/zh_cn/concepts2.md`, "added"),
      file(ZH, "removed"),
    ]);
    const existing = new Set([EN]);
    const moved = new Set([EN]);
    const resolved = resolveDerived(plans, existing);
    const old = pairWhere(resolved, (plan) => plan.zh.file?.path === ZH);
    expect(planAtHead(old, existing, moved)).toBe(false);
    expect(resolveSpecial([old], existing, moved)[0]).toMatchObject({
      en: { status: "removed" },
      zh: { status: "removed" },
    });
    const next = pairWhere(resolved, (plan) => plan.en.file?.path === `${ROOT}/concepts2.md`);
    expect(planAtHead(next, existing, moved)).toBe(true);
  });

  test("中文删除、英文未变时保留为 unchanged/removed", () => {
    const existing = new Set([EN]);
    const plans = resolveDerived(planSpecial([file(ZH, "removed")]), existing);
    expect(planAtHead(first(plans), existing, new Set())).toBe(true);
    expect(resolveSpecial(plans, existing)[0]).toMatchObject({
      en: { status: "unchanged" },
      zh: { status: "removed" },
    });
  });

  test("单文件删除不产出", () => {
    const path = `${ROOT}/plain.md`;
    const plans = planSpecial([file(path, "removed")]);
    expect(planAtHead(first(plans), new Set([path]), new Set())).toBe(false);
  });
});
