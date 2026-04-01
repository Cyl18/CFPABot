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
            Converters = { new JsonStringEnumConverter() }
        };

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
        public async Task<JsonResult> PRLLMReviewResult([FromQuery] int pr, [FromQuery] string mod)
        {
            if (ChristinaConfig.MockEnabled)
            {
                return new JsonResult(new ReviewFrontendDisplay
                {
                    FrontendDisplayItems = new List<ReviewFrontendDisplayItem>
                    {
                        new() { Key = "item.copper_ingot", Source = "Copper Ingot", Target = "铜锭" },
                        new() { Key = "item.iron_plate", Source = "Iron Plate", Target = "铁板" }
                    },
                    LLMOutputItems = new List<LlmItemOutput>
                    {
                        new() { Id = 0, Status = ReviewStatus.Pass, Issues = new List<LlmIssue>(), SuggestedTarget = "" },
                        new() { Id = 1, Status = ReviewStatus.Minor, Issues = new List<LlmIssue>
                        {
                            new() { Severity = IssueSeverity.Minor, Type = IssueType.Terminology, Message = "建议统一术语", Suggestion = "铁板", Reason = "术语统一" }
                        }, SuggestedTarget = "铁板" }
                    },
                    GlobalNotes = "整体翻译质量良好"
                }, _jsonOpts);
            }
            var diff = await GitHub.Diff(pr);
            var prInfo = await GitHub.GetPullRequest(pr);
            var headSha = prInfo.Head.Sha;
            var baseSha = prInfo.Base.Sha;

            var modPaths = PRAnalyzer.RunBleedingEdge(diff);
            var modPath = modPaths.FirstOrDefault(m => m.ToString() == mod);
            if (modPath == null)
                return new JsonResult(new { error = "mod not found" }, _jsonOpts);

            var enTask = new LangFilePath(modPath, LangType.EN).FetchFromCommit(headSha);
            var cnTask = new LangFilePath(modPath, LangType.CN).FetchFromCommit(headSha);
            var baseEnTask = new LangFilePath(modPath, LangType.EN).FetchFromCommit(baseSha);
            var baseCnTask = new LangFilePath(modPath, LangType.CN).FetchFromCommit(baseSha);
            await Task.WhenAll(enTask, cnTask, baseEnTask, baseCnTask);
            var enContent = await enTask;
            var cnContent = await cnTask;
            var baseEnContent = await baseEnTask;
            var baseCnContent = await baseCnTask;

            if (enContent == null || cnContent == null)
                return new JsonResult(new { error = "lang files not found" }, _jsonOpts);

            var en = JsonObjectEx.CreateFromString(enContent);
            var cn = JsonObjectEx.CreateFromString(cnContent);

            var enDict = en.Lines.ToDictionary(x => x.Key, x => x.Value);
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
                result = await LLMAssistantClient.GetLLMReviewResult(en, cn, modPath.CurseForgeSlug, modPath.GameVersionDirectoryName);
                await SaveReviewCache(pr, mod, headSha, result);
            }

            var displayItems = result.Items.Select(item =>
            {
                var line = item.Id < filteredLines.Length ? filteredLines[item.Id] : null;
                var key = line?.Key ?? "";
                return new ReviewFrontendDisplayItem
                {
                    Key = key,
                    Source = !string.IsNullOrEmpty(key) && enDict.TryGetValue(key, out var s) ? s : "",
                    Target = line?.Value ?? "",
                    BaseSource = !string.IsNullOrEmpty(key) && baseEnDict != null && baseEnDict.TryGetValue(key, out var bs) ? bs : null,
                    BaseTarget = !string.IsNullOrEmpty(key) && baseCnDict != null && baseCnDict.TryGetValue(key, out var bt) ? bt : null,
                };
            }).ToList();

            var display = new ReviewFrontendDisplay
            {
                FrontendDisplayItems = displayItems,
                LLMOutputItems = result.Items,
                GlobalNotes = result.GlobalNotes ?? ""
            };

            return new JsonResult(display, _jsonOpts);
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
