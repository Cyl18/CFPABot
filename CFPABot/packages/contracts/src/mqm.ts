import type { Severity } from "./api.ts";

export interface MqmDimensionInfo {
  id: string;
  label: string;
  scope: string;
}

export const MQM_DIMENSIONS = [
  { id: "accuracy", label: "准确", scope: "译文与原文的命题内容" },
  { id: "terminology", label: "术语", scope: "与冻结术语表、同篇用词的一致性" },
  { id: "fluency", label: "通顺", scope: "句子是否成立、自然、可读" },
  { id: "fit", label: "得体", scope: "表达是否适合文本类型、项目约定与目标读者" },
  { id: "design", label: "排版", scope: "占位符、格式码、长度等呈现约束" },
  { id: "source", label: "原文", scope: "上游文本自身的问题，不计在译者头上" },
] as const satisfies readonly MqmDimensionInfo[];

export type MqmDimension = (typeof MQM_DIMENSIONS)[number]["id"];

export interface MqmType {
  /** 草稿 mqm 字段的取值，形如 `<dim>/<type>`。 */
  id: string;
  dim: MqmDimension;
  label: string;

  /** 默认档位；实际档位按后果定，检查器只对低于默认档的条目给提示。 */
  severity: Severity;
  rule: string;
}

export const MQM_TYPES = [
  { id: "accuracy/mistranslation", dim: "accuracy", label: "错译", severity: "major", rule: "意思与原文不符：否定、指称、数量、关系、反义；只是读着别扭的走 fluency" },
  { id: "accuracy/omission", dim: "accuracy", label: "漏译", severity: "major", rule: "原文有的信息译文没有：整句、从句、限定词、条件；空值也算" },
  { id: "accuracy/addition", dim: "accuracy", label: "增译", severity: "minor", rule: "译文多出原文没有的信息：解释、串行、重复；必要的显化不算" },
  { id: "accuracy/untranslated", dim: "accuracy", label: "未译", severity: "major", rule: "该译的仍是英文；品牌、模组名、刻意保留的原样不算" },
  { id: "accuracy/do-not-translate", dim: "accuracy", label: "应留原文", severity: "major", rule: "保留清单要求原样，译文却译了；判据是保留清单，不是品牌名猜测" },

  { id: "terminology/resource", dim: "terminology", label: "术语不符", severity: "major", rule: "与冻结术语表不一致；表里没有的译名走 termProposals 或 wrong" },
  { id: "terminology/inconsistent", dim: "terminology", label: "术语不一", severity: "minor", rule: "同一概念在同片或相邻 key 用了不同译名；表里没有的走 termProposals" },
  { id: "terminology/wrong", dim: "terminology", label: "术语不当", severity: "major", rule: "表里没有、但译名是领域或社区里的坏选择；有把握才评论，拿不准或改表走 termProposals" },

  { id: "fluency/grammar", dim: "fluency", label: "语法", severity: "major", rule: "成分残缺、语序错、搭配错；读不通可升 major" },
  { id: "fluency/awkward", dim: "fluency", label: "生硬", severity: "major", rule: "语法成立但译腔、冗余、拗口，意思没变" },
  { id: "fluency/punctuation", dim: "fluency", label: "标点", severity: "minor", rule: "标点误用、引号括号不配对、句末缺失" },
  { id: "fluency/typo", dim: "fluency", label: "错别字", severity: "minor", rule: "错字、别字、形近字；术语用字错走 terminology" },

  { id: "fit/register", dim: "fit", label: "语域不符", severity: "minor", rule: "口吻或正式度与文本类型不符：物品描述写成说明书、按钮写成句子" },
  { id: "fit/house-style", dim: "fit", label: "体例不符", severity: "minor", rule: "与项目约定不符：全半角、中英混排空格、称呼、大小写、同模式句式" },
  { id: "fit/reference", dim: "fit", label: "文化引用", severity: "minor", rule: "引用保留了、意思还在，但目标读者接不住；意思丢了走 accuracy" },
  { id: "fit/offensive", dim: "fit", label: "冒犯", severity: "major", rule: "译文自己加戏让目标读者不适；源文带的走 source/defect" },

  { id: "design/markup", dim: "design", label: "格式码错", severity: "major", rule: "占位符、格式码、标签缺失、错位或语义错" },
  { id: "design/length", dim: "design", label: "长度超限", severity: "minor", rule: "译文显著长于原文，或超出按钮、提示框、物品名的可用长度" },

  { id: "source/defect", dim: "source", label: "原文问题", severity: "neutral", rule: "原文错误、歧义、占位符不全；内容不适合受众也算；不计在译者头上" },
] as const satisfies readonly MqmType[];

export const MQM_BY_ID: ReadonlyMap<string, MqmType> = new Map(MQM_TYPES.map((type) => [type.id, type]));

export function mqmLabel(id: string): string {
  return MQM_BY_ID.get(id)?.label ?? id;
}

/** 子代理系统提示与草稿 schema 共用这一份，词表只从 MQM_TYPES 来。 */
export function mqmTable(): string {
  return MQM_TYPES.map((type) => `${type.id} ${type.label} ${type.severity} — ${type.rule}`).join("\n");
}
