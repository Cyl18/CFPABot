import type { Severity } from "./api.ts";

export interface MqmDimensionInfo {
  id: string;
  label: string;
  scope: string;
}

export const MQM_DIMENSIONS = [
  { id: "accuracy", label: "准确", scope: "只判命题内容、言外之意与术语，不判句子顺不顺" },
  { id: "fluency", label: "通顺", scope: "只判句子是否成立、自然、可读，不判意思对不对" },
  { id: "fit", label: "得体", scope: "只判表达是否适配文本类型、使用场景和项目约定，不判意思对不对" },
  { id: "design", label: "排版", scope: "只判占位符、格式码、格式约定和长度，不判措辞" },
  { id: "source", label: "原文", scope: "只记上游文本自身的问题，不计在译者头上" },
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
  { id: "accuracy/mistranslation", dim: "accuracy", label: "错译", severity: "critical", rule: "译文把原文的否定、指称、数量、关系或反义译错了" },
  { id: "accuracy/omission", dim: "accuracy", label: "漏译", severity: "critical", rule: "译文丢了原文的整句、从句、限定成分或条件，甚至整条输出为空" },
  { id: "accuracy/addition", dim: "accuracy", label: "增译", severity: "minor", rule: "译文多出原文没有的解释、串行或重复；必要的显化不算增译" },
  { id: "accuracy/untranslated", dim: "accuracy", label: "未译", severity: "critical", rule: "该译的内容仍是英文；品牌名、模组名和刻意保留的原样不算未译" },
  { id: "accuracy/do-not-translate", dim: "accuracy", label: "应留原文", severity: "major", rule: "译文译出了保留清单里要求原样的内容；判定只看保留清单，不靠品牌名推断" },
  { id: "accuracy/terminology", dim: "accuracy", label: "术语不符", severity: "critical", rule: "译名与冻结表、领域标准或社区标准不符；译文在同词多义时选错了义项；表里没有的义项走提案，表本身有错走 dispute" },

  { id: "fluency/grammar", dim: "fluency", label: "语法", severity: "major", rule: "译文句子成分残缺、语序错或搭配不当" },
  { id: "fluency/awkward", dim: "fluency", label: "生硬", severity: "minor", rule: "译文句子语法成立，但读来有翻译腔，显得冗余或拗口" },
  { id: "fluency/punctuation", dim: "fluency", label: "标点", severity: "minor", rule: "译文标点误用，引号或括号不配对，句末标点缺失" },
  { id: "fluency/typo", dim: "fluency", label: "错别字", severity: "minor", rule: "译文出现错字、别字或形近字误用；术语用字错了，归 accuracy/terminology" },

  { id: "fit/register", dim: "fit", label: "语域不符", severity: "minor", rule: "译文口吻与文本类型不符，物品描述写成了说明书，按钮用了书面语，称呼上你/您混用" },
  { id: "fit/function", dim: "fit", label: "功能不符", severity: "major", rule: "译文没起到该 UI 元素应有的作用，按钮写成了句子，物品名写成了描述，提示写成了标题" },
  { id: "fit/tone", dim: "fit", label: "语气不符", severity: "minor", rule: "译文没译出原文的讽刺、紧急、玩笑或亲昵语气" },
  { id: "fit/culture", dim: "fit", label: "文化错位", severity: "minor", rule: "译文意象与原文设定冲突，中世纪奇幻里出现了现代网络用语，西幻里出现了中式典故" },
  { id: "fit/convention", dim: "fit", label: "体例不符", severity: "major", rule: "译文与项目约定不符，同模式句式不统一，固定提示语被改写" },

  { id: "design/markup", dim: "design", label: "格式码错", severity: "major", rule: "译文里的占位符、格式码或标签有缺失、错位或语义错误" },
  { id: "design/format", dim: "design", label: "格式不符", severity: "minor", rule: "全半角、中英混排空格或大小写与项目约定不符；术语的固定大小写错了，归 accuracy/terminology" },
  { id: "design/length", dim: "design", label: "长度超限", severity: "major", rule: "译文超出按钮、提示框、物品名的可用长度" },

  { id: "source/defect", dim: "source", label: "原文问题", severity: "neutral", rule: "原文本身有错误、歧义、占位符不全或不适宜内容" },
] as const satisfies readonly MqmType[];

export const MQM_BY_ID: ReadonlyMap<string, MqmType> = new Map(MQM_TYPES.map((type) => [type.id, type]));

export function mqmLabel(id: string): string {
  return MQM_BY_ID.get(id)?.label ?? id;
}

/** 子代理系统提示与草稿 schema 共用这一份，词表只从 MQM_TYPES 来。 */
export function mqmTable(): string {
  return MQM_TYPES.map((type) => `${type.id} ${type.label} ${type.severity} — ${type.rule}`).join("\n");
}
