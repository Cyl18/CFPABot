using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using CFPABot.Utils;
using Serilog;
using GammaLibrary.Extensions;

namespace CFPABot.Christina.LLMs
{
    public class LLMAssistantClient
    {
        /// <summary>Strip markdown code fences (```json ... ``` or ``` ... ```) from LLM responses.</summary>
        private static string StripMarkdownFences(string text)
        {
            if (text == null) return text;
            var trimmed = text.Trim();
            // Match ```json\n...\n``` or ```\n...\n```
            var match = Regex.Match(trimmed, @"^```(?:\w*)\s*\n?([\s\S]*?)\n?\s*```$");
            return match.Success ? match.Groups[1].Value.Trim() : trimmed;
        }


        private static readonly JsonSerializerOptions SerializeOptions = new()
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            IncludeFields = true,
            WriteIndented = false
        };

        // JSON Schema for the review batch output (used with OpenRouter structured outputs)
        private static readonly JsonElement ReviewBatchSchema = JsonDocument.Parse("""
            {
              "type": "object",
              "properties": {
                "batchSummary": {
                  "type": "object",
                  "properties": {
                    "pass": { "type": "integer" },
                    "minor": { "type": "integer" },
                    "needs_fix": { "type": "integer" },
                    "needs_context": { "type": "integer" }
                  },
                  "required": ["pass", "minor", "needs_fix", "needs_context"],
                  "additionalProperties": false
                },
                "items": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "properties": {
                      "id": { "type": "integer" },
                      "status": { "type": "string", "enum": ["pass", "minor", "needs_fix", "needs_context"] },
                      "issues": {
                        "type": "array",
                        "items": {
                          "type": "object",
                          "properties": {
                            "severity": { "type": "string", "enum": ["blocker", "major", "minor"] },
                            "type": { "type": "string", "enum": ["meaning", "terminology", "fluency", "style", "consistency", "placeholder", "formatting", "punctuation", "other"] },
                            "message": { "type": "string" },
                            "suggestion": { "type": "string" },
                            "reason": { "type": "string" }
                          },
                          "required": ["severity", "type", "message", "suggestion", "reason"],
                          "additionalProperties": false
                        }
                      },
                      "suggestedTarget": { "type": "string" }
                    },
                    "required": ["id", "status", "issues", "suggestedTarget"],
                    "additionalProperties": false
                  }
                },
                "globalNotes": {
                  "type": "array",
                  "items": { "type": "string" }
                }
              },
              "required": ["batchSummary", "items", "globalNotes"],
              "additionalProperties": false
            }
            """).RootElement.Clone();

        // JSON Schema for the consistency check output
        private static readonly JsonElement ConsistencyReportSchema = JsonDocument.Parse("""
            {
              "type": "object",
              "properties": {
                "inconsistencies": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "properties": {
                      "enTerm": { "type": "string" },
                      "variants": {
                        "type": "array",
                        "items": {
                          "type": "object",
                          "properties": {
                            "translation": { "type": "string" },
                            "entryIds": { "type": "array", "items": { "type": "integer" } }
                          },
                          "required": ["translation", "entryIds"],
                          "additionalProperties": false
                        }
                      }
                    },
                    "required": ["enTerm", "variants"],
                    "additionalProperties": false
                  }
                }
              },
              "required": ["inconsistencies"],
              "additionalProperties": false
            }
            """).RootElement.Clone();

        /// <summary>
        /// 对 en/cn 进行多模型并行审阅。
        /// </summary>
        /// <param name="en">英文 lang 文件</param>
        /// <param name="cn">中文 lang 文件</param>
        /// <param name="modId">模组 ID（用于 prompt）</param>
        /// <param name="mcVersionRange">游戏版本范围</param>
        /// <param name="importance">审阅重要度（low/medium/high）</param>
        /// <param name="models">
        ///   要并行审阅的模型列表，至少一个。
        ///   若为 null 或空，回退到默认 Gemini 模型。
        /// </param>
        /// <param name="consistencyModel">
        ///   如果非 null，先用该模型执行一致性检查，并将结果注入 style rules，再触发审阅批次。
        /// </param>
        /// <param name="consistencyScope">diff_only 或 full_mod</param>
        /// <param name="progress">多模型进度回调，每个模型独立上报。</param>
        /// <param name="ct">取消令牌</param>
        internal static async Task<(List<ModelBatchResult> ModelResults, ConsistencyReport? ConsistencyReport)> GetLLMReviewResult(
            JsonObjectEx en, JsonObjectEx cn,
            string modId, string mcVersionRange,
            string importance = "medium",
            IReadOnlyList<ModelSpec>? models = null,
            ModelSpec? consistencyModel = null,
            string consistencyScope = "diff_only",
            Func<ModelSpec, CancellationToken>? modelCancellationTokenFactory = null,
            IProgress<ReviewProgressUpdate>? progress = null,
            CancellationToken ct = default)
        {
            var enDict = en.Lines.ToDictionary(x => x.Key, x => x.Value);
            var filteredLines = cn.Lines.Where(x => enDict.ContainsKey(x.Key)).ToArray();

            var batches = SplitIntoBatches(filteredLines, enDict);

            var offsets = new int[batches.Count];
            int off = 0;
            for (int i = 0; i < batches.Count; i++)
            {
                offsets[i] = off;
                off += batches[i].Count;
            }

            // Effective model list — fall back to default Gemini if none specified
            var effectiveModels = (models == null || models.Count == 0)
                ? new List<ModelSpec> { new ModelSpec("gemini", GeminiMergeModel) }
                : models.ToList();

            // Phase 2: 一致性检查（阻塞，保证 style rules 在 batches 开始前就绪）
            ConsistencyReport? consistencyReport = null;
            string? consistencyStyleNote = null;
            if (consistencyModel != null)
            {
                Log.Information("LLMReview: 开始一致性检查, scope={Scope}, model={Model}", consistencyScope, consistencyModel.UniqueId);
                try
                {
                    // diff_only：只检查本次 PR 涉及的行（filteredLines = cn ∩ en，已按 batch 筛选）
                    // full_mod：检查整个 mod 的所有 cn 条目
                    var sourceLines = consistencyScope == "full_mod"
                        ? cn.Lines
                        : (IEnumerable<JsonLine>)filteredLines;
                    var entries = sourceLines
                        .Select(l => (l.Key, EnTerm: enDict.GetValueOrDefault(l.Key, ""), CnTerm: l.Value))
                        .ToList();
                    var consistencyLabel = $"Consistency · {consistencyModel.UniqueId}";
                    var consistencySummary = consistencyScope == "full_mod"
                        ? $"Running full-mod consistency check... ({entries.Count} entries)"
                        : $"Running consistency check... ({entries.Count} entries)";
                    progress?.Report(new ReviewProgressUpdate
                    {
                        Key = $"consistency:{consistencyModel.UniqueId}",
                        Label = consistencyLabel,
                        Completed = 0,
                        Total = 1,
                        Stage = "consistency",
                        Indeterminate = true,
                        StatusText = consistencySummary
                    });
                    consistencyReport = await GetConsistencyReport(entries, consistencyScope, consistencyModel, ct);
                    progress?.Report(new ReviewProgressUpdate
                    {
                        Key = $"consistency:{consistencyModel.UniqueId}",
                        Label = consistencyLabel,
                        Completed = 1,
                        Total = 1,
                        Stage = "consistency",
                        StatusText = consistencyReport?.Inconsistencies?.Count > 0
                            ? $"Consistency check complete. Found {consistencyReport.Inconsistencies.Count} inconsistencies."
                            : "Consistency check complete."
                    });
                    if (consistencyReport?.Inconsistencies?.Count > 0)
                    {
                        var lines = consistencyReport.Inconsistencies.Take(20).Select(i =>
                        {
                            var variantStr = i.Variants.Select(v =>
                            {
                                var refs = v.EntryIds.Take(3).Select(id => "#" + id).Connect(separator: ",");
                                return refs.NotNullNorEmpty()
                                    ? "\u300c" + v.Translation + "\u300d(" + refs + ")"
                                    : "\u300c" + v.Translation + "\u300d";
                            }).Connect(separator: "\u3001");
                            return "- " + i.EnTerm + ": " + variantStr;
                        });
                        consistencyStyleNote = "检测到以下术语存在不一致译法，请尽量统一：\n" + lines.Connect(separator: "\n");
                        Log.Information("LLMReview: 一致性检查完成，发现 {Count} 个术语不一致", consistencyReport.Inconsistencies.Count);
                    }
                }
                catch (OperationCanceledException) { throw; }
                catch (Exception ex)
                {
                    Log.Warning(ex, "LLMReview: 一致性检查失败，继续审阅");
                    progress?.Report(new ReviewProgressUpdate
                    {
                        Key = $"consistency:{consistencyModel.UniqueId}",
                        Label = $"Consistency · {consistencyModel.UniqueId}",
                        Completed = 1,
                        Total = 1,
                        Stage = "consistency",
                        StatusText = $"Consistency check failed: {ex.Message}"
                    });
                    consistencyReport = new ConsistencyReport
                    {
                        Inconsistencies = new List<ConsistencyInconsistency>(),
                        WasTruncated = false,
                        Error = $"一致性检查失败: {ex.Message}"
                    };
                }
            }

            Log.Information("LLMReview: {Total} batches x {Models} models", batches.Count, effectiveModels.Count);

            // 对每个模型并行运行所有 batches
            var modelTasks = effectiveModels.Select(spec =>
                RunModelReviewAsync(
                    spec,
                    enDict,
                    batches,
                    offsets,
                    filteredLines,
                    modId,
                    mcVersionRange,
                    importance,
                    consistencyStyleNote,
                    progress,
                    modelCancellationTokenFactory?.Invoke(spec) ?? ct)
            ).ToArray();

            var modelResults = await Task.WhenAll(modelTasks);
            return (modelResults.ToList(), consistencyReport);
        }

        private static async Task<ModelBatchResult> RunModelReviewAsync(
            ModelSpec spec,
            Dictionary<string, string> enDict,
            List<List<JsonLine>> batches,
            int[] offsets,
            JsonLine[] filteredLines,
            string modId, string mcVersionRange,
            string importance,
            string? consistencyStyleNote,
            IProgress<ReviewProgressUpdate>? progress,
            CancellationToken ct)
        {
            var provider = LLMProviderFactory.Create(spec);
            int completed = 0;
            int total = batches.Count;
            progress?.Report(new ReviewProgressUpdate
            {
                Key = spec.UniqueId,
                Label = spec.UniqueId,
                Completed = 0,
                Total = total,
                Stage = "review",
                StatusText = total > 0 ? $"Reviewing batches 0/{total}" : "Preparing review..."
            });

            try
            {
                var batchTasks = batches.Select(async (batch, i) =>
                {
                    var idOffset = offsets[i];
                    var result = await ProcessBatchAsync(provider, spec.ModelId, enDict, batch, idOffset, modId, mcVersionRange, importance, consistencyStyleNote, ct);
                    var done = Interlocked.Increment(ref completed);
                    progress?.Report(new ReviewProgressUpdate
                    {
                        Key = spec.UniqueId,
                        Label = spec.UniqueId,
                        Completed = done,
                        Total = total,
                        Stage = "review",
                        StatusText = $"Reviewing batches {done}/{total}"
                    });
                    return result;
                }).ToArray();

                var results = await Task.WhenAll(batchTasks);

                var allItems = results.SelectMany(r => r.items).OrderBy(x => x.Id).ToList();
                var allGlobalNotes = results.Select(r => r.notes).Where(n => !string.IsNullOrWhiteSpace(n)).ToList();
                var batchErrors = results.Select(r => r.batchError).Where(e => e != null).ToList();

                string mergedNotes;
                try
                {
                    progress?.Report(new ReviewProgressUpdate
                    {
                        Key = spec.UniqueId,
                        Label = spec.UniqueId,
                        Completed = total,
                        Total = total,
                        Merging = true,
                        Stage = "merge",
                        StatusText = "Merging results..."
                    });
                    mergedNotes = await MergeGlobalNotesAsync(provider, spec.ModelId, allItems, allGlobalNotes, ct);
                }
                catch (OperationCanceledException) { throw; }
                catch (Exception ex)
                {
                    Log.Warning(ex, "MergeGlobalNotesAsync failed for model={Model}", spec.ModelId);
                    mergedNotes = allGlobalNotes.Connect(separator: "\n");
                }

                return new ModelBatchResult { Spec = spec, Items = allItems, GlobalNotes = mergedNotes, BatchErrors = batchErrors.Count > 0 ? batchErrors : null };
            }
            catch (OperationCanceledException)
            {
                progress?.Report(new ReviewProgressUpdate
                {
                    Key = spec.UniqueId,
                    Label = spec.UniqueId,
                    Completed = completed,
                    Total = total,
                    Stage = "cancelled",
                    StatusText = "Cancelled"
                });
                return new ModelBatchResult
                {
                    Spec = spec,
                    Items = new List<LlmItemOutput>(),
                    GlobalNotes = "",
                    Cancelled = true,
                    BatchErrors = new List<string> { "Cancelled" }
                };
            }
        }

        private static async Task<(List<LlmItemOutput> items, string notes, string? batchError)> ProcessBatchAsync(
            ILLMProvider provider,
            string model,
            Dictionary<string, string> enDict,
            List<JsonLine> batch,
            int globalIdOffset,
            string modId, string mcVersionRange,
            string importance,
            string? consistencyStyleNote,
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

            var inputJson = batchInput.ToJsonString(SerializeOptions);
            string promptTemplate = importance.ToLowerInvariant() switch
            {
                "low" => LowSeverityPrompt,
                "high" => HighSeverityPrompt,
                _ => MediumSeverityPrompt
            };
            var prompt = promptTemplate.Replace("{{INPUT_JSON}}", inputJson);

            // 将一致性检查的术语不一致结果注入 style rules
            var baseSystemPrompt = consistencyStyleNote != null
                ? SystemPrompt + "\n\n额外术语一致性约束：\n" + consistencyStyleNote
                : SystemPrompt;

            try
            {
                var responseText = await provider.QueryWithSystemPromptStructuredAsync(baseSystemPrompt, prompt, model, ReviewBatchSchema, ct);
                var (items, batchNotes) = ParseBatchOutput(responseText, globalIdOffset);
                NormalizeRedundantSuggestions(items, entries, globalIdOffset);

                if (items.Count == 0 && entries.Count > 0)
                {
                    Log.Warning("ProcessBatchAsync: 首次解析返回空结果，idOffset={IdOffset}，model={Model}，进行重试", globalIdOffset, model);
                    var retryResponse = await provider.QueryWithSystemPromptStructuredAsync(baseSystemPrompt, prompt, model, ReviewBatchSchema, ct);
                    var (retryItems, retryNotes) = ParseBatchOutput(retryResponse, globalIdOffset);
                    NormalizeRedundantSuggestions(retryItems, entries, globalIdOffset);

                    if (retryItems.Count == 0)
                    {
                        var errMsg = $"batch@offset={globalIdOffset}: 两次解析均失败，原始响应长度={responseText?.Length ?? 0}，重试响应长度={retryResponse?.Length ?? 0}";
                        Log.Warning("ProcessBatchAsync: 重试后仍为空，{Msg}", errMsg);
                        return (BuildBatchFailureItems(entries, globalIdOffset, errMsg), retryNotes, errMsg);
                    }

                    return (retryItems, retryNotes, null);
                }

                return (items, batchNotes, null);
            }
            catch (OperationCanceledException) { throw; }
            catch (Exception ex)
            {
                var errMsg = $"batch@offset={globalIdOffset}: {ex.Message}";
                Log.Warning(ex, "ProcessBatchAsync: 请求失败，{Msg}", errMsg);
                return (BuildBatchFailureItems(entries, globalIdOffset, errMsg), "", errMsg);
            }
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
                json = StripMarkdownFences(json);
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
                        globalNotes = notesEl.EnumerateArray()
                            .Where(e => e.ValueKind == JsonValueKind.String)
                            .Select(e => e.GetString() ?? "")
                            .Where(s => !string.IsNullOrWhiteSpace(s)).Connect(separator: "\n");
                    }
                    else if (notesEl.ValueKind == JsonValueKind.String)
                    {
                        globalNotes = notesEl.GetString() ?? "";
                    }
                }
            }
            catch (JsonException ex)
            {
                Log.Warning(ex, "ParseBatchOutput: JSON parse failed at idOffset={IdOffset}, parsed {Count} items before failure. Raw response length={Len}",
                    idOffset, items.Count, json?.Length ?? 0);
            }

            return (items, globalNotes);
        }

        private static void NormalizeRedundantSuggestions(List<LlmItemOutput> items, List<ReviewEntry> entries, int globalIdOffset)
        {
            if (items.Count == 0 || entries.Count == 0)
                return;

            var targetById = entries.ToDictionary(x => x.Id + globalIdOffset, x => x.Target ?? "");
            foreach (var item in items)
            {
                if (!targetById.TryGetValue(item.Id, out var currentTarget))
                    continue;

                if (!string.Equals(NormalizeComparableText(item.SuggestedTarget), NormalizeComparableText(currentTarget), StringComparison.Ordinal))
                    continue;

                item.Status = ReviewStatus.Pass;
                item.SuggestedTarget = "";
                item.Issues = new List<LlmIssue>();
            }
        }

        private static string NormalizeComparableText(string? text)
            => (text ?? "").Replace("\r\n", "\n").Trim();

        private static ReviewStatus ParseReviewStatus(string? s) => s switch
        {
            "pass"          => ReviewStatus.Pass,
            "minor"         => ReviewStatus.Minor,
            "needs_fix"     => ReviewStatus.NeedsFix,
            "needs_context" => ReviewStatus.NeedsContext,
            _               => ReviewStatus.NotReviewed
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

        private static List<LlmItemOutput> BuildBatchFailureItems(List<ReviewEntry> entries, int idOffset, string message)
        {
            return entries.Select(entry => new LlmItemOutput
            {
                Id = idOffset + entry.Id,
                Status = ReviewStatus.NotReviewed,
                SuggestedTarget = "",
                Issues = new List<LlmIssue>
                {
                    new()
                    {
                        Severity = IssueSeverity.Major,
                        Type = IssueType.Other,
                        Message = "This entry was not reviewed because the batch failed.",
                        Suggestion = "",
                        Reason = message
                    }
                }
            }).ToList();
        }

        // ── GlobalNotes merge ──────────────────────────────────────────────────

        private static async Task<string> MergeGlobalNotesAsync(
            ILLMProvider provider,
            string model,
            List<LlmItemOutput> allItems,
            List<string> allGlobalNotes,
            CancellationToken ct)
        {
            if (allGlobalNotes.Count == 0)
            {
                Log.Information("MergeGlobalNotesAsync: no global notes, skipping");
                return "";
            }
            if (allGlobalNotes.Count == 1)
            {
                Log.Information("MergeGlobalNotesAsync: single batch note, skipping merge");
                return allGlobalNotes[0];
            }
            Log.Information("MergeGlobalNotesAsync: merging {Count} notes via {Model}", allGlobalNotes.Count, model);

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
            var itemsJson = simplifiedItems.ToJsonString(jsonOpts);
            var notesJson = allGlobalNotes.ToJsonString(jsonOpts);

            var prompt = string.Format(GeminiMergePrompt, itemsJson, notesJson);

            var result = await provider.QueryAsync(prompt, model, ct);

            try
            {
                var stripped = StripMarkdownFences(result ?? "[]");
                using var doc = JsonDocument.Parse(stripped);
                if (doc.RootElement.ValueKind == JsonValueKind.Array)
                {
                    return doc.RootElement.EnumerateArray()
                        .Where(e => e.ValueKind == JsonValueKind.String)
                        .Select(e => e.GetString() ?? "")
                        .Where(s => !string.IsNullOrWhiteSpace(s)).Connect(separator: "\n");
                }
            }
            catch (JsonException ex)
            {
                Log.Warning(ex, "MergeGlobalNotesAsync: JSON parse failed for merge result, falling back to raw text");
            }

            return result ?? "";
        }

        // ── Consistency check ──────────────────────────────────────────────────

        internal static async Task<ConsistencyReport> GetConsistencyReport(
            List<(string Key, string EnTerm, string CnTerm)> entries,
            string scope,
            ModelSpec consistencyModel,
            CancellationToken ct)
        {
            const int MaxTokenEstimate = 100_000;
            Log.Information("ConsistencyCheck: scope={Scope}, entries={Count}, model={Model}", scope, entries.Count, consistencyModel.UniqueId);
            var provider = LLMProviderFactory.Create(consistencyModel);

            // 估算 token 数量（chars/3）
            int totalChars = entries.Sum(e => e.EnTerm.Length + e.CnTerm.Length + 10);
            bool wasTruncated = false;
            List<(int Id, string EnTerm, string CnTerm)> effectiveEntries;

            if (totalChars / 3 > MaxTokenEstimate)
            {
                wasTruncated = true;
                // 截断到 token 预算内
                int budget = MaxTokenEstimate * 3;
                var limited = new List<(int Id, string EnTerm, string CnTerm)>();
                int used = 0;
                foreach (var (entry, index) in entries.Select((entry, index) => (entry, index)))
                {
                    var size = entry.EnTerm.Length + entry.CnTerm.Length + 10;
                    if (used + size > budget) break;
                    limited.Add((index + 1, entry.EnTerm, entry.CnTerm));
                    used += size;
                }
                effectiveEntries = limited;
            }
            else
            {
                effectiveEntries = entries
                    .Select((entry, index) => (index + 1, entry.EnTerm, entry.CnTerm))
                    .ToList();
            }

            var entriesJson = effectiveEntries.Select(e => new { id = e.Id, en = e.EnTerm, cn = e.CnTerm })
                .ToJsonString(new JsonSerializerOptions { WriteIndented = false });

            var prompt = ConsistencyPrompt.Replace("{{ENTRIES_JSON}}", entriesJson);
            var responseText = await provider.QueryWithSystemPromptStructuredAsync(string.Empty, prompt, consistencyModel.ModelId, ConsistencyReportSchema, ct);

            var inconsistencies = ParseConsistencyOutput(responseText);
            return new ConsistencyReport { Inconsistencies = inconsistencies, WasTruncated = wasTruncated };
        }

        private static List<ConsistencyInconsistency> ParseConsistencyOutput(string json)
        {
            var result = new List<ConsistencyInconsistency>();
            try
            {
                json = StripMarkdownFences(json);
                using var doc = JsonDocument.Parse(json);
                var root = doc.RootElement;
                JsonElement arr = root.ValueKind == JsonValueKind.Array ? root
                    : root.TryGetProperty("inconsistencies", out var el) ? el
                    : default;

                if (arr.ValueKind != JsonValueKind.Array) return result;

                foreach (var item in arr.EnumerateArray())
                {
                    var enTerm = item.TryGetProperty("enTerm", out var et) ? et.GetString() ?? "" : "";
                    var variants = new List<TermVariant>();
                    if (item.TryGetProperty("variants", out var vArr) && vArr.ValueKind == JsonValueKind.Array)
                    {
                        foreach (var v in vArr.EnumerateArray())
                        {
                            var translation = v.TryGetProperty("translation", out var tr) ? tr.GetString() ?? "" : "";
                            var entryIds = new List<int>();
                            if (v.TryGetProperty("entryIds", out var idArr) && idArr.ValueKind == JsonValueKind.Array)
                            {
                                foreach (var id in idArr.EnumerateArray())
                                {
                                    if (id.ValueKind == JsonValueKind.Number && id.TryGetInt32(out var entryId))
                                    {
                                        entryIds.Add(entryId);
                                    }
                                    else if (id.ValueKind == JsonValueKind.String && int.TryParse(id.GetString(), out entryId))
                                    {
                                        entryIds.Add(entryId);
                                    }
                                }
                            }
                            else if (v.TryGetProperty("keys", out var kArr) && kArr.ValueKind == JsonValueKind.Array)
                            {
                                foreach (var k in kArr.EnumerateArray())
                                {
                                    if (k.ValueKind == JsonValueKind.Number && k.TryGetInt32(out var entryId))
                                    {
                                        entryIds.Add(entryId);
                                    }
                                    else if (k.ValueKind == JsonValueKind.String && int.TryParse(k.GetString(), out entryId))
                                    {
                                        entryIds.Add(entryId);
                                    }
                                }
                            }
                            variants.Add(new TermVariant { Translation = translation, EntryIds = entryIds });
                        }
                    }
                    if (enTerm.NotNullNorEmpty() && variants.Count >= 2)
                        result.Add(new ConsistencyInconsistency { EnTerm = enTerm, Variants = variants });
                }
            }
            catch (JsonException ex)
            {
                Log.Warning(ex, "ParseConsistencyOutput: JSON parse failed. Raw response length={Len}", json?.Length ?? 0);
            }
            return result;
        }

        private const string ConsistencyPrompt = """
            你是 Minecraft 模组中文翻译一致性检查助手。你将收到一组翻译条目（id、en 原文、cn 译文）。
            请找出同一个英文术语/短语在不同条目中被翻译成了不同的中文译法（不一致现象）。
            只关注名词性短语和固定表达；忽略因语法变化导致的正常差异（如动名词、复数）。

            输入 JSON 如下：
            {{ENTRIES_JSON}}

            输出 JSON 格式如下（严格输出 JSON，不含任何额外文本或 Markdown 包装）：
            {
              "inconsistencies": [
                {
                  "enTerm": "英文术语原文",
                  "variants": [
                    { "translation": "译法A", "entryIds": [1, 2] },
                    { "translation": "译法B", "entryIds": [3] }
                  ]
                }
              ]
            }

            若没有不一致，输出 { "inconsistencies": [] }。
            """;

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

        private const string LowSeverityPrompt = """
                                                   你将进行【低重要度】快速审阅：优先找出会导致玩家困惑或明显错误的问题；不要对风格过度挑剔。

                                                   输入 JSON 如下：
                                                   {{INPUT_JSON}}

                                                   额外要求：
                                                   - 若本地 precheck 已标记 placeholder/formatting 错误：直接 needs_fix，并在 issues 中明确指出。
                                                   - 对术语/风格仅给“minor”级别建议，除非会误导含义。
                                                   - 尽量减少输出字数，但保持 JSON 合法。
                                                   """;

        private const string MediumSeverityPrompt = """
                                                   你将进行【中重要度】审阅：在保证准确性的前提下，检查术语一致性与上下文连贯性。参考 CFPA 风格：准确、统一、自然、避免过度机翻腔；专有名词遵循术语表与项目既有译法。

                                                   输入 JSON 如下：
                                                   {{INPUT_JSON}}

                                                   额外要求：
                                                   - 遇到“可能有多种合理译法”的情况：status 设为 minor 或 needs_context（视是否缺上下文），并在 issues 中给出 2 个候选译法（用“建议A：…；建议B：…”格式），说明各自倾向。
                                                   - 若需要更多信息，请优先 tool call 获取：key 的使用场景、相似条目既有译法、模板展开样例。
                                                   """;

        private const string HighSeverityPrompt = """
                                                   你将进行【高重要度】严格审阅：这些条目下载量高或影响面大。你需要尽量降低误翻风险。

                                                   输入 JSON 如下：
                                                   {{INPUT_JSON}}

                                                   额外要求：
                                                   - 对 subtitle / advancement / death message 等“句子型文本”，要求中文读起来自然，语气与场景匹配。
                                                   - 对 item/block 名称，要求简洁一致，避免冗余修饰。
                                                   - 遇到不确定的专有名词或机制名：先 tool call 拉取“源码/资源用法摘要”或“同模组相似译法”，再下结论。
                                                   - 输出的 issues 的 reason 要更明确，便于人工讨论与投票。
                                                   """;

        // - 若需要更多信息，请优先 tool call 获取：key 的使用场景、相似条目既有译法、模板展开样例。

        /// <summary>当首次响应无法解析时附加到 system prompt 末尾的重试提示。</summary>
        private const string RetryJsonOnlyHint = "\n\n重要：你的上次响应不是合法 JSON 或无法解析。请只返回合法 JSON 对象，不要包含任何说明文字、Markdown 代码块（```）或其他额外内容。";

        // 填入 OpenRouter 上用于批次审阅的模型名
        private const string OpenRouterReviewModel = "openrouter/free";

        // 填入 Gemini 上用于合并 GlobalNotes 的模型名
        public const string DefaultMergeModel = "gemini-3.1-flash-lite-preview";
        private const string GeminiMergeModel = DefaultMergeModel;

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
