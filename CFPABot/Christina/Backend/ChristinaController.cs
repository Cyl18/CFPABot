using CFPABot.Azusa;
using CFPABot.Christina.LLMs;
using CFPABot.DiffEngine;
using CFPABot.Utils;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Serilog;
using Serilog.Core;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Http;
using Ganss.Xss;
using Markdig;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Channels;
using System.Threading.Tasks;
using System.Collections.Concurrent;
using GammaLibrary.Extensions;

// For more information on enabling Web API for empty projects, visit https://go.microsoft.com/fwlink/?LinkID=397860
namespace CFPABot.Christina.Backend
{
    [Route("api/[controller]")]
    [ApiController]
    public class ChristinaController : ControllerBase
    {
        static HttpClient hc = new HttpClient();
        private readonly ChristinaDbContext _db;
        private readonly IServiceScopeFactory _scopeFactory;
        public ChristinaController(ChristinaDbContext db, IServiceScopeFactory scopeFactory) { _db = db; _scopeFactory = scopeFactory; }

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

            /// <summary>Last per-model progress message JSON for WS replay.</summary>
            public volatile string LastProgressMessage;

            private int _started = 0;
            /// <summary>Returns true only for the first caller — used to start the background task exactly once.</summary>
            public bool TryAcquireStart() => Interlocked.CompareExchange(ref _started, 1, 0) == 0;

            /// <summary>Subscribe a new per-request channel. If job already finished, replay final message immediately.</summary>
            public Channel<string> Subscribe(string progressReplay)
            {
                // Bounded channel: drop oldest progress messages if reader falls behind
                var ch = Channel.CreateBounded<string>(new BoundedChannelOptions(64)
                {
                    SingleReader = true,
                    FullMode = BoundedChannelFullMode.DropOldest
                });
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

            /// <summary>Remove a channel when client disconnects, preventing message accumulation.</summary>
            public void Unsubscribe(Channel<string> ch)
            {
                lock (_lock)
                {
                    _channels.Remove(ch);
                    ch.Writer.TryComplete();
                }
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

        private static readonly ConcurrentDictionary<string, ReviewJob> _wsJobs = new();
        private static readonly ConcurrentDictionary<string, CancellationTokenSource> _wsJobCts = new();

        // ── In-memory cache for PR content hashes (avoids hitting GitHub API on every history request) ──
        private static readonly ConcurrentDictionary<string, (string? hash, DateTime expiry)> _contentHashCache = new();

        // ── WebSocket config frame models ──
        private sealed record WsConfigFrame(
            string? Token,
            List<string>? Models,
            Dictionary<string, WsModelOverride>? PerModelOverrides,
            bool Consistency,
            string? ConsistencyScope,
            string? ConsistencyModel);

        private sealed record WsModelOverride(string? BaseUrl, string? ApiKey);

        private static List<ModelSpec> BuildModelSpecs(WsConfigFrame frame)
        {
            if (frame.Models == null || frame.Models.Count == 0)
                return new List<ModelSpec> { new ModelSpec("gemini", LLMAssistantClient.DefaultMergeModel) };

            var result = new List<ModelSpec>();
            foreach (var modelKey in frame.Models)
            {
                var sep = modelKey.IndexOf(':');
                if (sep < 1) continue;
                var provider = modelKey[..sep];
                var modelId  = modelKey[(sep + 1)..];
                var ov = frame.PerModelOverrides?.GetValueOrDefault(modelKey);
                result.Add(new ModelSpec(provider, modelId, ov?.BaseUrl, ov?.ApiKey));
            }
            return result.Count > 0 ? result : new List<ModelSpec> { new ModelSpec("gemini", LLMAssistantClient.DefaultMergeModel) };
        }

        private static string ComputeModelsHash(List<ModelSpec> models)
        {
            var sorted = models.Select(m => m.UniqueId).OrderBy(x => x).Connect(separator: "|");
            var bytes  = SHA256.HashData(sorted.ToUTF8Bytes());
            return Convert.ToHexString(bytes)[..12].ToLowerInvariant();
        }

        private static string? DecryptAuthToken(string encryptedToken)
        {
            try { return NETCore.Encrypt.EncryptProvider.AESDecrypt(encryptedToken, System.IO.File.ReadAllText("config/encrypt_key.txt"), "CACTUS&MAMARUO!!"); }
            catch { return null; }
        }

        private static readonly MarkdownPipeline _mdPipeline =
            new MarkdownPipelineBuilder().UseAdvancedExtensions().Build();

        private static string RenderMarkdownSafe(string? markdown)
        {
            if (markdown.IsNullOrEmpty()) return "";
            var html = Markdown.ToHtml(markdown, _mdPipeline);
            return new HtmlSanitizer().Sanitize(html);
        }

        private static ReviewFrontendDisplay CloneDisplay(ReviewFrontendDisplay display)
        {
            var json = display.ToJsonString(_jsonOpts);
            return json.JsonDeserialize<ReviewFrontendDisplay>(_jsonOpts)!;
        }

        private static void SanitizeDisplayMarkdown(ReviewFrontendDisplay display)
        {
            display.GlobalNotes = RenderMarkdownSafe(display.GlobalNotes);
            foreach (var mr in display.ModelResults ?? Enumerable.Empty<ModelBatchResult>())
            {
                mr.GlobalNotes = RenderMarkdownSafe(mr.GlobalNotes);
                foreach (var item in mr.Items ?? Enumerable.Empty<LlmItemOutput>())
                {
                    // SuggestedTarget is shown with x-text (not x-html), so no markdown rendering needed
                    foreach (var issue in item.Issues ?? Enumerable.Empty<LlmIssue>())
                    {
                        issue.Message    = RenderMarkdownSafe(issue.Message);
                        issue.Suggestion = RenderMarkdownSafe(issue.Suggestion);
                        issue.Reason     = RenderMarkdownSafe(issue.Reason);
                    }
                }
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
        [HttpGet("Login")]
        public IActionResult Login()
        {
            var loginUrl =
                $"https://github.com/login/oauth/authorize?client_id={CFPABot.Utils.Constants.GitHubOAuthClientId}&scope=user:email%20public_repo%20workflow&state=christina";
            return Redirect(loginUrl);
        }

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

        [HttpGet("ws/PRLLMReviewResult")]
        public async Task PRLLMReviewResultWs(
            [FromQuery] int pr,
            [FromQuery] string mod,
            [FromQuery] bool force = false,
            [FromQuery] string importance = "medium")
        {
            if (!HttpContext.WebSockets.IsWebSocketRequest)
            {
                HttpContext.Response.StatusCode = 400;
                return;
            }

            var ws = await HttpContext.WebSockets.AcceptWebSocketAsync();
            Log.Information("WS PRLLMReviewResult accepted for pr={Pr} mod={Mod} force={Force} importance={Importance}", pr, mod, force, importance);

            string Serialize(object data) => data.ToJsonString(_jsonOpts);

            async Task SendWs(string json)
            {
                var bytes = json.ToUTF8Bytes();
                try { await ws.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, CancellationToken.None); }
                catch { /* client disconnected */ }
            }

            async Task<bool> RejectWs(string reason)
            {
                await SendWs(Serialize(new { type = "error", message = reason }));
                try { await ws.CloseAsync(WebSocketCloseStatus.PolicyViolation, "", CancellationToken.None); } catch { }
                return false;
            }

            // ── Read first config frame (contains auth token + review config) ──
            WsConfigFrame configFrame;
            try
            {
                using var ms = new MemoryStream();
                var buf = new byte[65536];
                WebSocketReceiveResult wsRes;
                do
                {
                    wsRes = await ws.ReceiveAsync(new ArraySegment<byte>(buf), CancellationToken.None);
                    if (wsRes.MessageType == WebSocketMessageType.Close)
                    {
                        await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "", CancellationToken.None);
                        return;
                    }
                    ms.Write(buf, 0, wsRes.Count);
                } while (!wsRes.EndOfMessage);

                configFrame = ms.ToArray().ToUTF8String().JsonDeserialize<WsConfigFrame>(_jsonOpts)
                              ?? throw new InvalidOperationException("null config frame");
            }
            catch (Exception ex)
            {
                Log.Warning(ex, "WS PRLLMReviewResult: bad config frame");
                await SendWs(Serialize(new { type = "error", message = "invalid config frame" }));
                try { await ws.CloseAsync(WebSocketCloseStatus.InvalidPayloadData, "", CancellationToken.None); } catch { }
                return;
            }

            // ── Auth: try HTTP cookie first (works in cross-origin dev), fall back to frame token ──
            var cookieToken = LoginManager.GetToken(new Microsoft.AspNetCore.Http.HttpContextAccessor { HttpContext = HttpContext });
            var accessToken = cookieToken;
            if (accessToken == null)
            {
                var rawToken = configFrame.Token;
                if (!rawToken.IsNullOrEmpty())
                    accessToken = DecryptAuthToken(rawToken);
            }
            if (accessToken == null)
            {
                Log.Warning("WS PRLLMReviewResult unauthorized: missing token for pr={Pr} mod={Mod}", pr, mod);
                await RejectWs("unauthorized");
                return;
            }
            try
            {
                var ghClient = LoginManager.GetGitHubClient(accessToken);
                await ghClient.User.Current();
            }
            catch (Exception ex)
            {
                Log.Warning(ex, "WS PRLLMReviewResult unauthorized: token rejected for pr={Pr} mod={Mod}", pr, mod);
                await RejectWs("unauthorized");
                return;
            }

            var models = BuildModelSpecs(configFrame);

            ModelSpec? consistencyModel = null;
            if (configFrame.Consistency && configFrame.ConsistencyModel.NotNullNorEmpty())
            {
                var sep = configFrame.ConsistencyModel.IndexOf(':');
                if (sep > 0)
                {
                    var cmProvider = configFrame.ConsistencyModel[..sep];
                    var cmModelId  = configFrame.ConsistencyModel[(sep + 1)..];
                    var cmOv = configFrame.PerModelOverrides?.GetValueOrDefault(configFrame.ConsistencyModel);
                    consistencyModel = new ModelSpec(cmProvider, cmModelId, cmOv?.BaseUrl, cmOv?.ApiKey);
                }
            }

            var consistencyScope = configFrame.ConsistencyScope ?? "diff_only";
            var modelsHash = ComputeModelsHash(models);
            // force=true requests never share a job — each gets its own unique key
            var jobKey = force
                ? $"{pr}:{mod}:{importance}:{modelsHash}:force:{Guid.NewGuid():N}"
                : $"{pr}:{mod}:{importance}:{modelsHash}:{(configFrame.Consistency ? 1 : 0)}:{consistencyScope}:{consistencyModel?.UniqueId}";

            ReviewJob job;
            job = _wsJobs.GetOrAdd(jobKey, _ => new ReviewJob());

            if (job.TryAcquireStart())
            {
                var capturedModels           = models;
                var capturedConsistencyModel = consistencyModel;
                var capturedScope            = consistencyScope;
                var capturedScopeFactory     = _scopeFactory;
                var cts = new CancellationTokenSource();
                _wsJobCts[jobKey] = cts;

                _ = Task.Run(async () =>
                {
                    try
                    {
                        Log.Information("WS PRLLMReviewResult job started for pr={Pr} mod={Mod} force={Force} models={Models}", pr, mod, force, capturedModels.Select(x => x.UniqueId).Connect(","));
                        var diff    = await GitHub.Diff(pr);
                        var prInfo  = await GitHub.GetPullRequest(pr);
                        var headSha = prInfo.Head.Sha;
                        var baseSha = prInfo.Base.Sha;

                        var modPaths = PRAnalyzer.RunBleedingEdge(diff);
                        var modPath  = modPaths.FirstOrDefault(m => m.ToString() == mod);
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

                        var en     = JsonObjectEx.CreateFromString(enContent);
                        var cn     = JsonObjectEx.CreateFromString(cnContent);
                        var enDict = en.Lines.ToDictionary(x => x.Key, x => x.Value);
                        var filteredLines = cn.Lines.Where(x => enDict.ContainsKey(x.Key)).ToArray();

                        var baseEnDict = baseEnContent != null
                            ? JsonObjectEx.CreateFromString(baseEnContent).Lines.ToDictionary(x => x.Key, x => x.Value)
                            : null;
                        var baseCnDict = baseCnContent != null
                            ? JsonObjectEx.CreateFromString(baseCnContent).Lines.ToDictionary(x => x.Key, x => x.Value)
                            : null;

                        // Try new hash-based cache
                        var cacheEntries = filteredLines.Select(l => (l.Key, enDict.GetValueOrDefault(l.Key, ""), l.Value));
                        var cacheHash = LlmReviewCache.ComputeHash(capturedModels, importance, configFrame.Consistency, capturedScope, capturedConsistencyModel?.UniqueId, cacheEntries);
                        var display = force ? null : await LlmReviewCache.TryLoad(cacheHash);

                        ReviewFrontendDisplay wssDisplay;
                        if (display != null)
                        {
                            Log.Information("WS cache hit hash={Hash}", cacheHash);
                            wssDisplay = CloneDisplay(display);
                            SanitizeDisplayMarkdown(wssDisplay); // ensure sanitization even if cache was written by an older build
                        }
                        else
                        {
                            // Per-model progress state
                            var perModelState = new ConcurrentDictionary<string, ReviewProgressUpdate>();
                            var wsProgress = new Progress<ReviewProgressUpdate>(p =>
                            {
                                perModelState[p.Key] = p;

                                var perModel = perModelState.Values
                                    .OrderBy(v => v.Stage == "consistency" ? 0 : 1)
                                    .ThenBy(v => v.Label, StringComparer.Ordinal)
                                    .Select(v => new
                                {
                                    key           = v.Key,
                                    modelId       = v.Key,
                                    label         = v.Label,
                                    completed     = v.Completed,
                                    total         = v.Total,
                                    merging       = v.Merging,
                                    indeterminate = v.Indeterminate,
                                    stage         = v.Stage,
                                    statusText    = v.StatusText
                                }).ToList();

                                var msg = Serialize(new { type = "progress", perModel });
                                job.LastProgressMessage = msg;
                                job.Broadcast(msg);
                            });

                            var (modelResults, consistencyReport) = await LLMAssistantClient.GetLLMReviewResult(
                                en, cn, modPath.CurseForgeSlug, modPath.GameVersionDirectoryName,
                                importance,
                                models:             capturedModels,
                                consistencyModel:   capturedConsistencyModel,
                                consistencyScope:   capturedScope,
                                progress:           wsProgress,
                                ct:                 cts.Token);

                            // Build display rows from the full filtered line set so partial batch failures
                            // do not drop rows or shift item ids in the frontend.
                            var displayItems = filteredLines.Select((line, index) =>
                            {
                                var key = line.Key;
                                return new ReviewFrontendDisplayItem
                                {
                                    Id         = index,
                                    Key        = key,
                                    Source     = key.NotNullNorEmpty() && enDict.TryGetValue(key, out var s) ? s : "",
                                    Target     = line?.Value ?? "",
                                    BaseSource = key.NotNullNorEmpty() && baseEnDict != null && baseEnDict.TryGetValue(key, out var bs) ? bs : null,
                                    BaseTarget = key.NotNullNorEmpty() && baseCnDict != null && baseCnDict.TryGetValue(key, out var bt) ? bt : null,
                                };
                            }).ToList();

                            display = new ReviewFrontendDisplay
                            {
                                FrontendDisplayItems = displayItems,
                                ModelResults         = modelResults,
                                GlobalNotes          = modelResults.Count > 0 ? modelResults[0].GlobalNotes ?? "" : "",
                                ConsistencyReport    = consistencyReport
                            };
                            // Save raw markdown to cache BEFORE sanitizing so reload doesn't double-render
                            var contentHash = LlmReviewCache.ComputeContentHash(cacheEntries);
                            using (var scope = capturedScopeFactory.CreateScope())
                            {
                                var scopedDb = scope.ServiceProvider.GetRequiredService<ChristinaDbContext>();
                                await LlmReviewCache.Save(scopedDb, cacheHash, display, pr, mod, capturedModels, importance, configFrame.Consistency, contentHash);
                            }
                            wssDisplay = CloneDisplay(display);
                            SanitizeDisplayMarkdown(wssDisplay);
                        }

                        job.Finish(Serialize(new { type = "done", result = wssDisplay, hash = cacheHash }));
                    }
                    catch (OperationCanceledException)
                    {
                        Log.Information("WS PRLLMReviewResult cancelled for pr={Pr} mod={Mod}", pr, mod);
                        job.Finish(Serialize(new { type = "error", message = "Review cancelled" }));
                    }
                    catch (Exception ex)
                    {
                        Log.Error(ex, "WS PRLLMReviewResult failed for pr={Pr} mod={Mod}", pr, mod);
                        job.Finish(Serialize(new { type = "error", message = ex.Message }));
                    }
                    finally
                    {
                        _wsJobCts.TryRemove(jobKey, out var removedCts);
                        removedCts?.Dispose();
                        // Delay removal so late-joining clients within 60 s get the replay instead of restarting
                        _ = Task.Delay(TimeSpan.FromSeconds(60))
                            .ContinueWith(_t => _wsJobs.TryRemove(jobKey, out _), TaskScheduler.Default);
                    }
                });
            }

            var channel = job.Subscribe(job.LastProgressMessage);

            // Listen for cancel messages from client in background
            _ = Task.Run(async () =>
            {
                try
                {
                    var buf = new byte[4096];
                    var msgBuilder = new System.Text.StringBuilder();
                    while (ws.State == WebSocketState.Open)
                    {
                        var res = await ws.ReceiveAsync(new ArraySegment<byte>(buf), HttpContext.RequestAborted);
                        if (res.MessageType == WebSocketMessageType.Close) break;
                        msgBuilder.Append(Encoding.UTF8.GetString(buf, 0, res.Count));
                        if (!res.EndOfMessage) continue;
                        var msg = msgBuilder.ToString();
                        msgBuilder.Clear();
                        try
                        {
                            var el = msg.JsonDeserialize<System.Text.Json.JsonElement>();
                            if (el.TryGetProperty("type", out var tp) && tp.GetString() == "cancel"
                                && _wsJobCts.TryGetValue(jobKey, out var jobCts))
                            {
                                Log.Information("WS PRLLMReviewResult: client requested cancel for job={JobKey}", jobKey);
                                jobCts.Cancel();
                            }
                        }
                        catch { /* ignore malformed frames */ }
                    }
                }
                catch { /* client disconnected */ }
            });

            try
            {
                await foreach (var msg in channel.Reader.ReadAllAsync(HttpContext.RequestAborted))
                    await SendWs(msg);
            }
            catch (OperationCanceledException) { }
            finally
            {
                job.Unsubscribe(channel);
            }

            if (ws.State == WebSocketState.Open)
                try { await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "", CancellationToken.None); } catch { }
        }

        // ── Model config endpoints ──────────────────────────────────────────────────
        public sealed record AddUserModelRequest(string Provider, string ModelId, string DisplayName, string? BaseUrl);
        public sealed record AddPresetRequest(string Provider, string ModelId, string DisplayName);
        public sealed record ReorderRequest(List<int> Ids);

        [HttpGet("ModelConfigs")]
        [RequireLogin]
        public async Task<IActionResult> GetModelConfigs()
        {
            var user   = HttpContext.GetGhUser();
            var userId = user.Id.ToString();
            try
            {
                var globalPresets = await _db.GlobalModelPresets
                    .Where(p => p.IsActive)
                    .OrderBy(p => p.SortOrder)
                    .ThenBy(p => p.Id)
                    .Select(p => new { p.Id, p.Provider, p.ModelId, p.DisplayName, p.SortOrder })
                    .ToListAsync();
                var userModels = await _db.UserModelConfigs
                    .Where(m => m.GithubUserId == userId)
                    .OrderBy(m => m.SortOrder)
                    .ThenBy(m => m.Id)
                    .Select(m => new { m.Id, m.Provider, m.ModelId, m.DisplayName, m.BaseUrl, m.SortOrder })
                    .ToListAsync();
                return new JsonResult(new { globalPresets, userModels }, _jsonOpts);
            }
            catch (Exception e)
            {
                Log.Error(e, "GetModelConfigs");
                return StatusCode(500);
            }
        }

        [HttpPost("ModelConfigs")]
        [RequireLogin]
        public async Task<IActionResult> AddUserModel([FromBody] AddUserModelRequest req)
        {
            if (string.IsNullOrWhiteSpace(req.ModelId) || string.IsNullOrWhiteSpace(req.DisplayName) || string.IsNullOrWhiteSpace(req.Provider))
                return BadRequest("Missing required fields");
            // Only admin can add custom-provider models
            if (req.Provider == "custom" && !await LoginManager.IsAdmin(HttpContext.GetGhUser()).ConfigureAwait(false))
                return Forbid();
            var user = HttpContext.GetGhUser();
            try
            {
                var userId = user.Id.ToString();
                var nextSortOrder = (await _db.UserModelConfigs
                    .Where(m => m.GithubUserId == userId)
                    .Select(m => (int?)m.SortOrder)
                    .MaxAsync()) ?? 0;
                var config = new UserModelConfig
                {
                    GithubUserId = userId,
                    Provider     = req.Provider,
                    ModelId      = req.ModelId,
                    DisplayName  = req.DisplayName,
                    BaseUrl      = req.BaseUrl,
                    CreatedAt    = DateTime.UtcNow,
                    SortOrder    = nextSortOrder + 1
                };
                _db.UserModelConfigs.Add(config);
                await _db.SaveChangesAsync();
                return new JsonResult(new { id = config.Id }, _jsonOpts);
            }
            catch (Exception e)
            {
                Log.Error(e, "AddUserModel");
                return StatusCode(500);
            }
        }

        [HttpPut("ModelConfigs/{id:int}")]
        [RequireLogin]
        public async Task<IActionResult> UpdateUserModel(int id, [FromBody] AddUserModelRequest req)
        {
            if (string.IsNullOrWhiteSpace(req.ModelId) || string.IsNullOrWhiteSpace(req.DisplayName) || string.IsNullOrWhiteSpace(req.Provider))
                return BadRequest("Missing required fields");
            if (req.Provider == "custom" && !await LoginManager.IsAdmin(HttpContext.GetGhUser()).ConfigureAwait(false))
                return Forbid();

            var userId = HttpContext.GetGhUser().Id.ToString();
            try
            {
                var model = await _db.UserModelConfigs.FindAsync(id);
                if (model == null) return NotFound();
                if (model.GithubUserId != userId) return Forbid();

                model.Provider = req.Provider;
                model.ModelId = req.ModelId;
                model.DisplayName = req.DisplayName;
                model.BaseUrl = req.BaseUrl;

                await _db.SaveChangesAsync();
                return Ok();
            }
            catch (Exception e)
            {
                Log.Error(e, "UpdateUserModel");
                return StatusCode(500);
            }
        }

        [HttpPost("ModelConfigs/reorder")]
        [RequireLogin]
        public async Task<IActionResult> ReorderUserModels([FromBody] ReorderRequest req)
        {
            var userId = HttpContext.GetGhUser().Id.ToString();
            try
            {
                var models = await _db.UserModelConfigs
                    .Where(m => m.GithubUserId == userId)
                    .ToListAsync();

                if (req.Ids == null || req.Ids.Count != models.Count || req.Ids.Distinct().Count() != models.Count)
                    return BadRequest("Invalid ids");

                var map = models.ToDictionary(m => m.Id);
                if (req.Ids.Any(id => !map.ContainsKey(id)))
                    return BadRequest("Invalid ids");

                for (var i = 0; i < req.Ids.Count; i++)
                    map[req.Ids[i]].SortOrder = i + 1;

                await _db.SaveChangesAsync();
                return Ok();
            }
            catch (Exception e)
            {
                Log.Error(e, "ReorderUserModels");
                return StatusCode(500);
            }
        }

        [HttpDelete("ModelConfigs/{id:int}")]
        [RequireLogin]
        public async Task<IActionResult> DeleteUserModel(int id)
        {
            var user   = HttpContext.GetGhUser();
            var userId = user.Id.ToString();
            try
            {
                var model = await _db.UserModelConfigs.FindAsync(id);
                if (model == null) return NotFound();
                if (model.GithubUserId != userId) return Forbid();
                _db.UserModelConfigs.Remove(model);
                await _db.SaveChangesAsync();
                return Ok();
            }
            catch (Exception e)
            {
                Log.Error(e, "DeleteUserModel");
                return StatusCode(500);
            }
        }

        [HttpPost("AdminModelPresets")]
        [RequireAdmin]
        public async Task<IActionResult> AddGlobalPreset([FromBody] AddPresetRequest req)
        {
            if (string.IsNullOrWhiteSpace(req.ModelId) || string.IsNullOrWhiteSpace(req.DisplayName) || string.IsNullOrWhiteSpace(req.Provider))
                return BadRequest("Missing required fields");
            try
            {
                var nextSortOrder = (await _db.GlobalModelPresets
                    .Where(p => p.IsActive)
                    .Select(p => (int?)p.SortOrder)
                    .MaxAsync()) ?? 0;
                var preset = new GlobalModelPreset
                {
                    Provider    = req.Provider,
                    ModelId     = req.ModelId,
                    DisplayName = req.DisplayName,
                    IsActive    = true,
                    SortOrder   = nextSortOrder + 1
                };
                _db.GlobalModelPresets.Add(preset);
                await _db.SaveChangesAsync();
                return new JsonResult(new { id = preset.Id }, _jsonOpts);
            }
            catch (Exception e)
            {
                Log.Error(e, "AddGlobalPreset");
                return StatusCode(500);
            }
        }

        [HttpPut("AdminModelPresets/{id:int}")]
        [RequireAdmin]
        public async Task<IActionResult> UpdateGlobalPreset(int id, [FromBody] AddPresetRequest req)
        {
            if (string.IsNullOrWhiteSpace(req.ModelId) || string.IsNullOrWhiteSpace(req.DisplayName) || string.IsNullOrWhiteSpace(req.Provider))
                return BadRequest("Missing required fields");
            try
            {
                var preset = await _db.GlobalModelPresets.FindAsync(id);
                if (preset == null) return NotFound();

                preset.Provider = req.Provider;
                preset.ModelId = req.ModelId;
                preset.DisplayName = req.DisplayName;

                await _db.SaveChangesAsync();
                return Ok();
            }
            catch (Exception e)
            {
                Log.Error(e, "UpdateGlobalPreset");
                return StatusCode(500);
            }
        }

        [HttpPost("AdminModelPresets/reorder")]
        [RequireAdmin]
        public async Task<IActionResult> ReorderGlobalPresets([FromBody] ReorderRequest req)
        {
            try
            {
                var presets = await _db.GlobalModelPresets
                    .Where(p => p.IsActive)
                    .ToListAsync();

                if (req.Ids == null || req.Ids.Count != presets.Count || req.Ids.Distinct().Count() != presets.Count)
                    return BadRequest("Invalid ids");

                var map = presets.ToDictionary(p => p.Id);
                if (req.Ids.Any(id => !map.ContainsKey(id)))
                    return BadRequest("Invalid ids");

                for (var i = 0; i < req.Ids.Count; i++)
                    map[req.Ids[i]].SortOrder = i + 1;

                await _db.SaveChangesAsync();
                return Ok();
            }
            catch (Exception e)
            {
                Log.Error(e, "ReorderGlobalPresets");
                return StatusCode(500);
            }
        }

        [HttpDelete("AdminModelPresets/{id:int}")]
        [RequireAdmin]
        public async Task<IActionResult> DeleteGlobalPreset(int id)
        {
            try
            {
                var preset = await _db.GlobalModelPresets.FindAsync(id);
                if (preset == null) return NotFound();
                _db.GlobalModelPresets.Remove(preset);
                await _db.SaveChangesAsync();
                return Ok();
            }
            catch (Exception e)
            {
                Log.Error(e, "DeleteGlobalPreset");
                return StatusCode(500);
            }
        }

        // ── Review history endpoints ────────────────────────────────────────────────
        [HttpGet("PRReviewHistory")]
        [RequireLogin]
        public async Task<IActionResult> PRReviewHistory([FromQuery] int pr, [FromQuery] string mod)
        {
            try
            {
                // Compute current content hash (cached for 60s to avoid hitting GitHub API on every request)
                string? currentContentHash = null;
                var cacheKey = $"{pr}:{mod}";
                if (_contentHashCache.TryGetValue(cacheKey, out var cached) && cached.expiry > DateTime.UtcNow)
                {
                    currentContentHash = cached.hash;
                }
                else
                {
                    try
                    {
                        var prInfo  = await GitHub.GetPullRequest(pr);
                        var headSha = prInfo.Head.Sha;
                        var diff     = await GitHub.Diff(pr);
                        var modPaths = PRAnalyzer.RunBleedingEdge(diff);
                        var modPath  = modPaths.FirstOrDefault(m => m.ToString() == mod);
                        if (modPath != null)
                        {
                            var enContent = await new LangFilePath(modPath, LangType.EN).FetchFromCommit(headSha);
                            var cnContent = await new LangFilePath(modPath, LangType.CN).FetchFromCommit(headSha);
                            if (enContent != null && cnContent != null)
                            {
                                var en           = JsonObjectEx.CreateFromString(enContent);
                                var cn           = JsonObjectEx.CreateFromString(cnContent);
                                var enDict       = en.Lines.ToDictionary(x => x.Key, x => x.Value);
                                var entries      = cn.Lines.Where(x => enDict.ContainsKey(x.Key))
                                                           .Select(l => (l.Key, enDict.GetValueOrDefault(l.Key, ""), l.Value));
                                currentContentHash = LlmReviewCache.ComputeContentHash(entries);
                            }
                        }
                        _contentHashCache[cacheKey] = (currentContentHash, DateTime.UtcNow.AddSeconds(60));
                    }
                    catch (Exception ex)
                    {
                        Log.Warning(ex, "PRReviewHistory: failed to compute currentContentHash for pr={Pr} mod={Mod}", pr, mod);
                    }
                }

                var entries2 = await LlmReviewCache.ListHistory(_db, pr, mod, currentContentHash);
                return new JsonResult(entries2, _jsonOpts);
            }
            catch (Exception e)
            {
                Log.Error(e, "PRReviewHistory");
                return StatusCode(500);
            }
        }

        [HttpGet("PRReviewCacheEntry")]
        [RequireLogin]
        public async Task<IActionResult> PRReviewCacheEntry([FromQuery] string hash)
        {
            // Validate hash format to prevent path traversal
            if (hash.IsNullOrEmpty() || !System.Text.RegularExpressions.Regex.IsMatch(hash, @"^[a-f0-9]{24}$"))
                return BadRequest("invalid hash");
            try
            {
                var display = await LlmReviewCache.LoadByHash(hash);
                if (display == null) return NotFound();
                var clone = CloneDisplay(display);
                SanitizeDisplayMarkdown(clone);
                return new JsonResult(new { result = clone }, _jsonOpts);
            }
            catch (Exception e)
            {
                Log.Error(e, "PRReviewCacheEntry hash={Hash}", hash);
                return StatusCode(500);
            }
        }

        record UserStatusResult(bool IsError, string UserName, string AvatarUrl, bool? IsAdmin);
        // GET api/Christina
        [HttpGet("UserStatus")]
        [RequireLogin]
        public async Task<JsonResult> UserStatus()
        {
            try
            {
                var user = HttpContext.GetGhUser();
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
