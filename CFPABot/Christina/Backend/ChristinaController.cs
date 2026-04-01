using CFPABot.Azusa;
using CFPABot.Christina.LLMs;
using CFPABot.DiffEngine;
using CFPABot.Utils;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Serilog;
using Serilog.Core;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Channels;
using System.Threading.Tasks;

// For more information on enabling Web API for empty projects, visit https://go.microsoft.com/fwlink/?LinkID=397860
namespace CFPABot.Christina.Backend
{
    [Route("api/[controller]")]
    [ApiController]
    public class ChristinaController : ControllerBase
    {
        static HttpClient hc = new HttpClient();

        private static readonly JsonSerializerOptions _jsonOpts = new()
        {
            IncludeFields = true,
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            Converters = { new JsonStringEnumConverter() }
        };

        // ── Shared job registry: one LLM task per PR+mod, shared across all subscribers ──
        private sealed class ReviewJob
        {
            private readonly List<Channel<string>> _channels = new();
            private readonly object _lock = new();
            private bool _finished;
            private string _finalMessage;

            public int ProgressCompleted;
            public int ProgressTotal;
            public bool Merging;

            /// <summary>Subscribe a new per-request channel. If job already finished, replay final message immediately.</summary>
            public Channel<string> Subscribe(string progressReplay)
            {
                var ch = Channel.CreateUnbounded<string>(new UnboundedChannelOptions { SingleReader = true });
                lock (_lock)
                {
                    if (_finished)
                    {
                        if (_finalMessage != null) ch.Writer.TryWrite(_finalMessage);
                        ch.Writer.TryComplete();
                    }
                    else
                    {
                        if (progressReplay != null) ch.Writer.TryWrite(progressReplay);
                        _channels.Add(ch);
                    }
                }
                return ch;
            }

            public void Broadcast(string message)
            {
                lock (_lock)
                    foreach (var ch in _channels) ch.Writer.TryWrite(message);
            }

            public void Finish(string finalMessage)
            {
                lock (_lock)
                {
                    _finished = true;
                    _finalMessage = finalMessage;
                    foreach (var ch in _channels)
                    {
                        ch.Writer.TryWrite(finalMessage);
                        ch.Writer.TryComplete();
                    }
                    _channels.Clear();
                }
            }
        }

        private static readonly System.Collections.Concurrent.ConcurrentDictionary<string, ReviewJob> _activeJobs = new();

        private static string GetCacheFilePath(int pr, string mod, string sha)
        {
            var safeMod = mod.Replace('/', '_').Replace('\\', '_');
            return Path.Combine("caches/llm-review-cache", $"{pr}-{safeMod}-{sha}.json");
        }

        private static async Task<LlmBatchOutput> TryLoadReviewCache(int pr, string mod, string sha)
        {
            var path = GetCacheFilePath(pr, mod, sha);
            if (!System.IO.File.Exists(path)) return null;
            try
            {
                var json = await System.IO.File.ReadAllTextAsync(path);
                return JsonSerializer.Deserialize<LlmBatchOutput>(json, _jsonOpts);
            }
            catch (Exception e)
            {
                Log.Warning(e, "Failed to read review cache {Path}", path);
                return null;
            }
        }

        private static async Task SaveReviewCache(int pr, string mod, string sha, LlmBatchOutput result)
        {
            var path = GetCacheFilePath(pr, mod, sha);
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                var json = JsonSerializer.Serialize(result, _jsonOpts);
                await System.IO.File.WriteAllTextAsync(path, json);
            }
            catch (Exception e)
            {
                Log.Warning(e, "Failed to write review cache {Path}", path);
            }
        }

        // GET: api/Christina
        // [HttpGet("GetApiLimit")]
        // public async Task<JsonResult> GetApiLimit()
        // {
        //
        //
        // }

        record PRModsResult(string[] Mods);
        [HttpGet("PRMods")]
        public async Task<JsonResult> PRMods([FromQuery] int pr)
        {
            if (ChristinaConfig.MockEnabled)
            {
                return new JsonResult(new PRModsResult(new[] { "create/1.20", "create/1.21", "gregtech/26.1.0" }), _jsonOpts);
            }
            var diff = await GitHub.Diff(pr);
            var modPaths = PRAnalyzer.RunBleedingEdge(diff);
            var mods = modPaths
                .Where(m => m.MinecraftVersion != MinecraftVersion.v1_12)
                .Select(m => m.ToString())
                .Distinct()
                .ToArray();
            return new JsonResult(new PRModsResult(mods), _jsonOpts);
        }

        [HttpGet("PRLLMReviewResult")]
        public async Task PRLLMReviewResult([FromQuery] int pr, [FromQuery] string mod)
        {
            Response.Headers.Append("Content-Type", "text/event-stream");
            Response.Headers.Append("Cache-Control", "no-cache");
            Response.Headers.Append("X-Accel-Buffering", "no");

            string Serialize(object data) => JsonSerializer.Serialize(data, _jsonOpts);

            if (ChristinaConfig.MockEnabled)
            {
                var mockDisplay = new ReviewFrontendDisplay
                {
                    FrontendDisplayItems = new List<ReviewFrontendDisplayItem>
                    {
                        new() { Key = "item.copper_ingot", Source = "Copper Ingot", Target = "铜锭" },
                        new() { Key = "item.iron_plate",   Source = "Iron Plate",   Target = "铁板" }
                    },
                    LlmOutputItems = new List<LlmItemOutput>
                    {
                        new() { Id = 0, Status = ReviewStatus.Pass, Issues = new List<LlmIssue>(), SuggestedTarget = "" },
                        new() { Id = 1, Status = ReviewStatus.Minor, Issues = new List<LlmIssue>
                        {
                            new() { Severity = IssueSeverity.Minor, Type = IssueType.Terminology, Message = "建议统一术语", Suggestion = "铁板", Reason = "术语统一" }
                        }, SuggestedTarget = "铁板" }
                    },
                    GlobalNotes = "整体翻译质量良好"
                };
                await Response.WriteAsync($"data: {Serialize(new { type = "done", result = mockDisplay })}\n\n");
                await Response.Body.FlushAsync();
                return;
            }

            var jobKey = $"{pr}:{mod}";

            // GetOrAdd with a factory that also starts the background task
            ReviewJob job;
            bool isNewJob = false;
            job = _activeJobs.GetOrAdd(jobKey, _ =>
            {
                isNewJob = true;
                return new ReviewJob();
            });

            if (isNewJob)
            {
                // Start background task — never cancelled, runs to completion regardless of clients
                _ = Task.Run(async () =>
                {
                    try
                    {
                        var diff = await GitHub.Diff(pr);
                        var prInfo = await GitHub.GetPullRequest(pr);
                        var headSha = prInfo.Head.Sha;
                        var baseSha = prInfo.Base.Sha;

                        var modPaths = PRAnalyzer.RunBleedingEdge(diff);
                        var modPath = modPaths.FirstOrDefault(m => m.ToString() == mod);
                        if (modPath == null)
                        {
                            job.Finish(Serialize(new { type = "error", message = "mod not found" }));
                            return;
                        }

                        var enTask     = new LangFilePath(modPath, LangType.EN).FetchFromCommit(headSha);
                        var cnTask     = new LangFilePath(modPath, LangType.CN).FetchFromCommit(headSha);
                        var baseEnTask = new LangFilePath(modPath, LangType.EN).FetchFromCommit(baseSha);
                        var baseCnTask = new LangFilePath(modPath, LangType.CN).FetchFromCommit(baseSha);
                        await Task.WhenAll(enTask, cnTask, baseEnTask, baseCnTask);

                        var enContent     = await enTask;
                        var cnContent     = await cnTask;
                        var baseEnContent = await baseEnTask;
                        var baseCnContent = await baseCnTask;

                        if (enContent == null || cnContent == null)
                        {
                            job.Finish(Serialize(new { type = "error", message = "lang files not found" }));
                            return;
                        }

                        var en = JsonObjectEx.CreateFromString(enContent);
                        var cn = JsonObjectEx.CreateFromString(cnContent);

                        var enDict        = en.Lines.ToDictionary(x => x.Key, x => x.Value);
                        var filteredLines = cn.Lines.Where(x => enDict.ContainsKey(x.Key)).ToArray();

                        var baseEnDict = baseEnContent != null
                            ? JsonObjectEx.CreateFromString(baseEnContent).Lines.ToDictionary(x => x.Key, x => x.Value)
                            : null;
                        var baseCnDict = baseCnContent != null
                            ? JsonObjectEx.CreateFromString(baseCnContent).Lines.ToDictionary(x => x.Key, x => x.Value)
                            : null;

                        var result = await TryLoadReviewCache(pr, mod, headSha);
                        if (result == null)
                        {
                            var progress = new Progress<(int completed, int total)>(p =>
                            {
                                string msg;
                                if (p.completed == -1)
                                {
                                    job.ProgressCompleted = job.ProgressTotal;
                                    job.Merging = true;
                                    msg = Serialize(new { type = "progress", completed = job.ProgressTotal, total = job.ProgressTotal, merging = true });
                                }
                                else
                                {
                                    job.ProgressCompleted = p.completed;
                                    job.ProgressTotal     = p.total;
                                    msg = Serialize(new { type = "progress", completed = p.completed, total = p.total });
                                }
                                job.Broadcast(msg);
                            });

                            result = await LLMAssistantClient.GetLLMReviewResult(
                                en, cn, modPath.CurseForgeSlug, modPath.GameVersionDirectoryName,
                                progress, CancellationToken.None);
                            await SaveReviewCache(pr, mod, headSha, result);
                        }

                        var displayItems = result.Items.Select(item =>
                        {
                            var line = item.Id < filteredLines.Length ? filteredLines[item.Id] : null;
                            var key  = line?.Key ?? "";
                            return new ReviewFrontendDisplayItem
                            {
                                Key        = key,
                                Source     = !string.IsNullOrEmpty(key) && enDict.TryGetValue(key, out var s) ? s : "",
                                Target     = line?.Value ?? "",
                                BaseSource = !string.IsNullOrEmpty(key) && baseEnDict != null && baseEnDict.TryGetValue(key, out var bs) ? bs : null,
                                BaseTarget = !string.IsNullOrEmpty(key) && baseCnDict != null && baseCnDict.TryGetValue(key, out var bt) ? bt : null,
                            };
                        }).ToList();

                        var display = new ReviewFrontendDisplay
                        {
                            FrontendDisplayItems = displayItems,
                            LlmOutputItems       = result.Items,
                            GlobalNotes          = result.GlobalNotes ?? ""
                        };

                        job.Finish(Serialize(new { type = "done", result = display }));
                    }
                    catch (Exception ex)
                    {
                        Log.Error(ex, "PRLLMReviewResult failed for pr={Pr} mod={Mod}", pr, mod);
                        job.Finish(Serialize(new { type = "error", message = ex.Message }));
                    }
                    finally
                    {
                        _activeJobs.TryRemove(jobKey, out _);
                    }
                });
            }

            // Build replay message so late joiners see current progress immediately
            string replayMsg = null;
            if (job.ProgressTotal > 0)
                replayMsg = job.Merging
                    ? Serialize(new { type = "progress", completed = job.ProgressTotal, total = job.ProgressTotal, merging = true })
                    : Serialize(new { type = "progress", completed = job.ProgressCompleted, total = job.ProgressTotal });

            var channel = job.Subscribe(replayMsg);

            // Stream from per-request channel to HTTP response; stop if client disconnects
            await foreach (var msg in channel.Reader.ReadAllAsync(CancellationToken.None))
            {
                try
                {
                    await Response.WriteAsync($"data: {msg}\n\n", CancellationToken.None);
                    await Response.Body.FlushAsync(CancellationToken.None);
                }
                catch
                {
                    break; // client disconnected — background task keeps running
                }
            }
        }


        record UserStatusResult(bool IsError, string UserName, string AvatarUrl, bool? IsAdmin);
        // GET api/Christina
        [HttpGet("UserStatus")]
        public async Task<JsonResult> UserStatus()
        {
            try
            {
                var client = LoginManager.GetGitHubClient(new HttpContextAccessor() { HttpContext = HttpContext });
                var user = await client.User.Current();
                var username = user.Login;
                var avatarUrl = user.AvatarUrl;
                var isAdmin = await LoginManager.IsAdmin(user);
                return new JsonResult(new UserStatusResult(false, username, avatarUrl, isAdmin));
            }
            catch (Exception e)
            {
                Log.Error(e, "UserStatus");
                return new JsonResult(new UserStatusResult(true, null, null, null));
            }
        }
        //
    }
}
