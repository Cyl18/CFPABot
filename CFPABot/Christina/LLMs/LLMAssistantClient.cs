using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using CFPABot.Utils;

namespace CFPABot.Christina.LLMs
{
    public class LLMAssistantClient
    {


        private static readonly JsonSerializerOptions SerializeOptions = new()
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            IncludeFields = true,
            WriteIndented = false
        };

        internal static async Task<LlmBatchOutput> GetLLMReviewResult(
            JsonObjectEx en, JsonObjectEx cn,
            string modId, string mcVersionRange,
            IProgress<(int completed, int total)>? progress = null,
            CancellationToken ct = default)
        {
            var enDict = en.Lines.ToDictionary(x => x.Key, x => x.Value);
            var filteredLines = cn.Lines.Where(x => enDict.ContainsKey(x.Key)).ToArray();

            var batches = SplitIntoBatches(filteredLines, enDict);

            // Pre-calculate global id offsets so batches can run concurrently
            var offsets = new int[batches.Count];
            int off = 0;
            for (int i = 0; i < batches.Count; i++)
            {
                offsets[i] = off;
                off += batches[i].Count;
            }

            var openRouter = new OpenRouterClient();
            int completed = 0;
            int total = batches.Count;

            var batchTasks = batches.Select((batch, i) =>
            {
                var idOffset = offsets[i];
                return ProcessBatchAsync(openRouter, enDict, batch, idOffset, modId, mcVersionRange, ct)
                    .ContinueWith(t =>
                    {
                        Interlocked.Increment(ref completed);
                        progress?.Report((Volatile.Read(ref completed), total));
                        return t.GetAwaiter().GetResult(); // propagate exceptions
                    }, TaskScheduler.Default);
            }).ToArray();

            var results = await Task.WhenAll(batchTasks);

            var allItems = results.SelectMany(r => r.items).OrderBy(x => x.Id).ToList();
            var allGlobalNotes = results.Select(r => r.notes)
                .Where(n => !string.IsNullOrWhiteSpace(n)).ToList();

            string mergedNotes;
            try
            {
                progress?.Report((-1, total)); // signal: merging
                mergedNotes = await MergeGlobalNotesAsync(allItems, allGlobalNotes, ct);
            }
            catch (Exception ex)
            {
                Serilog.Log.Warning(ex, "MergeGlobalNotesAsync failed, returning empty notes");
                mergedNotes = string.Join("\n", allGlobalNotes);
            }

            return new LlmBatchOutput
            {
                Items = allItems,
                GlobalNotes = mergedNotes
            };
        }

        private static async Task<(List<LlmItemOutput> items, string notes)> ProcessBatchAsync(
            OpenRouterClient openRouter,
            Dictionary<string, string> enDict,
            List<JsonLine> batch,
            int globalIdOffset,
            string modId, string mcVersionRange,
            CancellationToken ct)
        {
            var entries = batch.Select((line, i) => new ReviewEntry
            {
                Id = i,
                Key = line.Key,
                Source = enDict.TryGetValue(line.Key, out var enVal) ? enVal : "",
                Target = line.Value
            }).ToList();

            var batchInput = new ReviewBatchInput
            {
                ModId = modId,
                McVersionRange = mcVersionRange,
                Entries = entries
            };

            var inputJson = JsonSerializer.Serialize(batchInput, SerializeOptions);
            var prompt = string.Format(MediumSeverityPrompt, inputJson);

            var responseText = await openRouter.QueryWithSystemPromptAsync(
                SystemPrompt, prompt,
                new ModelPolicy(OpenRouterReviewModel),
                ct);

            var (items, batchNotes) = ParseBatchOutput(responseText, globalIdOffset);
            return (items, batchNotes);
        }

        // ── Batching ──────────────────────────────────────────────────────────

        private static List<List<JsonLine>> SplitIntoBatches(
            JsonLine[] lines, Dictionary<string, string> enDict)
        {
            var batches = new List<List<JsonLine>>();
            var current = new List<JsonLine>();

            foreach (var line in lines)
            {
                current.Add(line);

                bool tooManyTokens = EstimateTokens(current, enDict) > 5000;
                bool atMaxLines = current.Count >= 50;

                if (tooManyTokens || atMaxLines)
                {
                    if (tooManyTokens && current.Count > 1)
                    {
                        var overflow = current[^1];
                        current.RemoveAt(current.Count - 1);
                        batches.Add(current);
                        current = new List<JsonLine> { overflow };
                    }
                    else
                    {
                        batches.Add(current);
                        current = new List<JsonLine>();
                    }
                }
            }

            if (current.Count > 0)
                batches.Add(current);

            return batches;
        }

        private static int EstimateTokens(
            List<JsonLine> batch,
            Dictionary<string, string> enDict)
        {
            int chars = 0;
            foreach (var line in batch)
            {
                chars += line.Key.Length;
                chars += enDict.TryGetValue(line.Key, out var src) ? src.Length : 0;
                chars += line.Value.Length;
                chars += 50; // per-entry JSON structure overhead
            }
            return chars / 3; // rough chars-per-token estimate (mixed CN/EN)
        }

        // ── Response parsing ──────────────────────────────────────────────────

        private static (List<LlmItemOutput> items, string globalNotes)
            ParseBatchOutput(string json, int idOffset)
        {
            var items = new List<LlmItemOutput>();
            var globalNotes = "";

            try
            {
                using var doc = JsonDocument.Parse(json);
                var root = doc.RootElement;

                if (root.TryGetProperty("items", out var itemsEl))
                {
                    foreach (var itemEl in itemsEl.EnumerateArray())
                    {
                        var rawId = itemEl.TryGetProperty("id", out var idEl) ? idEl.GetInt32() : 0;
                        var item = new LlmItemOutput
                        {
                            Id = rawId + idOffset,
                            Status = ParseReviewStatus(itemEl.TryGetProperty("status", out var stEl) ? stEl.GetString() : null),
                            Issues = new List<LlmIssue>(),
                            SuggestedTarget = itemEl.TryGetProperty("suggestedTarget", out var sugEl) ? sugEl.GetString() ?? "" : ""
                        };

                        if (itemEl.TryGetProperty("issues", out var issuesEl))
                        {
                            foreach (var issueEl in issuesEl.EnumerateArray())
                            {
                                item.Issues.Add(new LlmIssue
                                {
                                    Severity = ParseIssueSeverity(issueEl.TryGetProperty("severity", out var sevEl) ? sevEl.GetString() : null),
                                    Type = ParseIssueType(issueEl.TryGetProperty("type", out var typeEl) ? typeEl.GetString() : null),
                                    Message = issueEl.TryGetProperty("message", out var msgEl) ? msgEl.GetString() ?? "" : "",
                                    Suggestion = issueEl.TryGetProperty("suggestion", out var suggestEl) ? suggestEl.GetString() ?? "" : "",
                                    Reason = issueEl.TryGetProperty("reason", out var reasonEl) ? reasonEl.GetString() ?? "" : ""
                                });
                            }
                        }

                        items.Add(item);
                    }
                }

                if (root.TryGetProperty("globalNotes", out var notesEl))
                {
                    if (notesEl.ValueKind == JsonValueKind.Array)
                    {
                        globalNotes = string.Join("\n", notesEl.EnumerateArray()
                            .Where(e => e.ValueKind == JsonValueKind.String)
                            .Select(e => e.GetString() ?? "")
                            .Where(s => !string.IsNullOrWhiteSpace(s)));
                    }
                    else if (notesEl.ValueKind == JsonValueKind.String)
                    {
                        globalNotes = notesEl.GetString() ?? "";
                    }
                }
            }
            catch (JsonException) { /* return whatever was parsed so far */ }

            return (items, globalNotes);
        }

        private static ReviewStatus ParseReviewStatus(string? s) => s switch
        {
            "pass"          => ReviewStatus.Pass,
            "minor"         => ReviewStatus.Minor,
            "needs_fix"     => ReviewStatus.NeedsFix,
            "needs_context" => ReviewStatus.NeedsContext,
            _               => ReviewStatus.Pass
        };

        private static IssueSeverity ParseIssueSeverity(string? s) => s switch
        {
            "blocker" => IssueSeverity.Blocker,
            "major"   => IssueSeverity.Major,
            _         => IssueSeverity.Minor
        };

        private static IssueType ParseIssueType(string? s) => s switch
        {
            "meaning"     => IssueType.Meaning,
            "terminology" => IssueType.Terminology,
            "fluency"     => IssueType.Fluency,
            "style"       => IssueType.Style,
            "consistency" => IssueType.Consistency,
            "placeholder" => IssueType.Placeholder,
            "formatting"  => IssueType.Formatting,
            "punctuation" => IssueType.Punctuation,
            _             => IssueType.Other
        };

        // ── GlobalNotes merge via Gemini ──────────────────────────────────────

        private static async Task<string> MergeGlobalNotesAsync(
            List<LlmItemOutput> allItems,
            List<string> allGlobalNotes,
            CancellationToken ct)
        {
            if (allGlobalNotes.Count == 0) return "";
            if (allGlobalNotes.Count == 1) return allGlobalNotes[0];

            var simplifiedItems = allItems.Select(item => new
            {
                id = item.Id,
                status = item.Status.ToString().ToLowerInvariant(),
                issues = item.Issues?.Select(iss => new
                {
                    severity   = iss.Severity.ToString().ToLowerInvariant(),
                    type       = iss.Type.ToString().ToLowerInvariant(),
                    message    = iss.Message,
                    suggestion = iss.Suggestion
                }).ToList()
            });

            var jsonOpts = new JsonSerializerOptions { WriteIndented = false };
            var itemsJson = JsonSerializer.Serialize(simplifiedItems, jsonOpts);
            var notesJson = JsonSerializer.Serialize(allGlobalNotes, jsonOpts);

            var prompt = string.Format(GeminiMergePrompt, itemsJson, notesJson);

            var gemini = new GeminiClient(
                new ApiKeyPool(new[] { Constants.GeminiApiKey }), Constants.GeminiEndpoint);

            var result = await gemini.QueryAsync(prompt, new ModelPolicy(GeminiMergeModel), ct);

            try
            {
                using var doc = JsonDocument.Parse(result ?? "[]");
                if (doc.RootElement.ValueKind == JsonValueKind.Array)
                {
                    return string.Join("\n", doc.RootElement.EnumerateArray()
                        .Where(e => e.ValueKind == JsonValueKind.String)
                        .Select(e => e.GetString() ?? "")
                        .Where(s => !string.IsNullOrWhiteSpace(s)));
                }
            }
            catch (JsonException) { }

            return result ?? "";
        }
        private const string SystemPrompt = """
                                            你是 Minecraft 模组中文本地化审阅助手。你将收到一个 JSON 输入，包含若干条翻译条目（key、类型、原文、译文、占位符、格式码、本地预检查结果、少量术语表与相邻条目）。

                                            你的任务：
                                            1) 在不臆测上下文的前提下，检查译文的：语义准确、术语一致、中文自然程度、风格是否符合条目类型（方块/物品名简洁；subtitle/提示句子通顺；UI 简短明确；tooltip 可口语但要清晰）。
                                            2) 严格保护格式与占位符：不得丢失、增删或改变顺序（除非明确指出为修复）。
                                            3) 若上下文不足以判断（例如 subtitle 的语气、某个专有名词是否应音译/意译），请使用工具调用请求更多信息，而不是猜测。
                                            4) 仅输出“有效 JSON”，不得输出任何额外文本。不要将JSON文本包含在Markdown内。

                                            输出 JSON 结构要求：
                                            {
                                              "batchSummary": { "pass": number, "minor": number, "needs_fix": number, "needs_context": number },
                                              "items": [
                                                {
                                                  "id": number,
                                                  "status": "pass" | "minor" | "needs_fix" | "needs_context",
                                                  "issues": [
                                                    {
                                                      "severity": "blocker" | "major" | "minor",
                                                      "type": "meaning" | "terminology" | "fluency" | "style" | "consistency" | "placeholder" | "formatting" | "punctuation" | "other",
                                                      "message": "问题描述（中文，短句）",
                                                      "suggestion": "建议译文或修复建议（尽量给出可直接替换的中文）",
                                                      "reason": "一句话理由"
                                                    }
                                                  ],
                                                  "suggestedTarget": "若需要，给出你建议的最终译文；否则为空字符串"
                                                }
                                              ],
                                              "globalNotes": [ "批量层面的统一建议（可为空数组）" ]
                                            }

                                            判定标准：
                                            - pass：不需要改或仅有极轻微建议
                                            - minor：有建议但不改也能接受
                                            - needs_fix：存在明显错误、歧义、严重不自然、术语明显不一致、或格式/占位符问题
                                            - needs_context：必须拿到上下文才能给出可靠结论
                                            """;

        private const string MediumSeverityPrompt = """
                                                   你将进行【中重要度】审阅：在保证准确性的前提下，检查术语一致性与上下文连贯性。

                                                   输入 JSON 如下：
                                                   {0}

                                                   额外要求：
                                                   - 遇到“可能有多种合理译法”的情况：status 设为 minor 或 needs_context（视是否缺上下文），并在 issues 中给出 2 个候选译法（用“建议A：…；建议B：…”格式），说明各自倾向。
                                                   """;

        // - 若需要更多信息，请优先 tool call 获取：key 的使用场景、相似条目既有译法、模板展开样例。

        // 填入 OpenRouter 上用于批次审阅的模型名
        private const string OpenRouterReviewModel = "openrouter/free";

        // 填入 Gemini 上用于合并 GlobalNotes 的模型名
        private const string GeminiMergeModel = "gemini-3-flash-preview";

        private const string GeminiMergePrompt = """
                                                 你是翻译审阅汇总助手。你将收到若干批次翻译审阅的批次级总结（globalNotes），以及所有审阅条目的简化上下文（含 id、状态、问题列表，不含 key）。
                                                 请将所有 globalNotes 去重、归纳并合并，输出一份统一的简体中文总结，格式为 JSON 字符串数组，每条为一句简明建议。
                                                 严格仅输出有效 JSON 数组，禁止包含任何额外文本或 Markdown 格式。

                                                 全量条目简化上下文：
                                                 {0}

                                                 各批次 globalNotes：
                                                 {1}
                                                 """;
    }


    }
    