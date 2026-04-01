using System.Collections.Generic;

namespace CFPABot.Christina.LLMs
{
    enum ImportanceLevel { Low, Medium, High }

    // 条目类型（本地分类，不让 LLM 猜）
    enum EntryKind { Block, Item, Entity, Subtitle, Tooltip, Ui, Advancement, Config, Command, Misc }

    enum ReviewStatus { Pass, Minor, NeedsFix, NeedsContext }

    enum IssueSeverity { Blocker, Major, Minor }

    enum IssueType { Meaning, Terminology, Fluency, Style, Consistency, Placeholder, Formatting, Punctuation, Other }

    // 本地预检查结果（确定性）
    sealed class PrecheckResult
    {
        public bool JsonValid;
        public bool PlaceholdersMatch;
        public bool FormattingTokensMatch;
        public bool HasSuspiciousWhitespace;
        public List<string> Errors;   // 例如：缺少 %s、§ 颜色码不一致
        public List<string> Warnings; // 例如：首尾空格、全角半角混用
    }

    sealed class ReviewEntry
    {
        public int Id;                // batch 内唯一
        public string Key;            // 只给本条 key
        //public EntryKind Kind;        // 本地推断
        public string Source;         // en_us
        public string Target;         // zh_cn
        //public string FilePath;       // 例如 `mods/<siteId>/<modid>/lang/zh_cn.json` 或 DSL 路径
        //public PrecheckResult Precheck;

        // 省 token：只放命中的术语/相邻参考
        //public Dictionary<string, string> GlossaryHits; // term -> preferred zh
        //public List<(string Key, string Target)> Neighbors; // 最多 3 条
        //public string ContextHint; // 可为空：一句话用途摘要
    }

    sealed class ReviewBatchInput
    {
        public string ModId;
        //public string ModName;
        // public ImportanceLevel Importance;
        public string McVersionRange; // 可为空
        public List<ReviewEntry> Entries;

        //public Dictionary<string, string> GlobalGlossary; // 可选：仅放本批会用到的
        public string StyleRules = """
                                   以原文含义为准，避免过度发挥；不确定则标 needs_context。
                                   保持术语一致：同概念在同模组内尽量同译；优先采用术语表命中译法。
                                   译文应符合中文习惯：语序自然，避免机翻腔。
                                   严禁丢失/改动占位符、格式码、换行符、标签等；如发现不一致直接 needs_fix。
                                   不能缺少 %s、§ 颜色码不一致、首尾空格、全角半角混用
                                   标点与原版风格一致，优先中文全角标点；中英文混排不随意加空格（Patchouli 例外见专项）。
                                   物品/方块名要求简洁一致，避免不必要修饰。
                                   句子型文本（提示/进度/死亡/字幕）要求通顺、语气符合场景。
                                   单位与专有缩写：FE/RF/mB 等缩写保留；国际单位可译为中文单位名。
                                   禁止不适宜烂梗与带负面影响的梗。
                                   作者要求高于本指南；发现原文明显错误可合理处理并建议反馈。
                                   """; // 短规则列表
    }

    sealed class ReviewFrontendDisplay
    {
        public List<ReviewFrontendDisplayItem> FrontendDisplayItems;
        public List<LlmItemOutput> LLMOutputItems;
        public string GlobalNotes;
    }

    sealed class ReviewFrontendDisplayItem
    {
        public string Key;
        public string Source; // en (head)
        public string Target; // cn (head)
        public string? BaseSource; // en (base, may be null)
        public string? BaseTarget; // cn (base, may be null)
    }

    // LLM 输出结构（与 prompt 中 JSON 对应）
    sealed class LlmBatchOutput
    {
        // public BatchSummary BatchSummary;
        public List<LlmItemOutput> Items;
        public string GlobalNotes;
    }

    sealed class LlmItemOutput
    {
        public int Id;
        public ReviewStatus Status;
        public List<LlmIssue> Issues;
        public string SuggestedTarget;
    }

    sealed class LlmIssue
    {
        public IssueSeverity Severity;
        public IssueType Type;
        public string Message;
        public string Suggestion;
        public string Reason;
    }
}
