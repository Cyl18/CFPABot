#nullable enable
using CFPABot.Christina.LLMs;
using Microsoft.EntityFrameworkCore;
using Serilog;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Tasks;
using GammaLibrary.Extensions;

namespace CFPABot.Christina.Backend
{
    internal sealed record CacheHistoryEntry(
        string Hash,
        DateTime CachedAt,
        string[] Models,
        string Importance,
        bool Consistency,
        bool IsStale);

    internal static class LlmReviewCache
    {
        private static readonly string CacheDir = Path.Combine("config", "llm-review-cache");
        private static readonly TimeSpan CacheTtl = TimeSpan.FromDays(30);

        private static readonly JsonSerializerOptions _jsonOpts = new()
        {
            IncludeFields = true,
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            Converters = { new JsonStringEnumConverter() }
        };

        private sealed class CacheFile
        {
            [JsonPropertyName("cachedAt")]    public DateTime CachedAt { get; set; }
            [JsonPropertyName("pr")]          public int Pr { get; set; }
            [JsonPropertyName("mod")]         public string? Mod { get; set; }
            [JsonPropertyName("models")]      public string[]? Models { get; set; }
            [JsonPropertyName("importance")]  public string? Importance { get; set; }
            [JsonPropertyName("consistency")] public bool Consistency { get; set; }
            [JsonPropertyName("contentHash")] public string? ContentHash { get; set; }
            [JsonPropertyName("result")]      public ReviewFrontendDisplay Result { get; set; } = null!;
        }

        /// <summary>Hash of only (key, en, cn) content — independent of models/importance/consistency.</summary>
        internal static string ComputeContentHash(IEnumerable<(string key, string en, string cn)> entries)
        {
            var entriesStr = entries.Select(e => $"{e.key}\t{e.en}\t{e.cn}").Connect(separator: "\n");
            var bytes      = SHA256.HashData(entriesStr.ToUTF8Bytes());
            return Convert.ToHexString(bytes)[..24].ToLowerInvariant();
        }

        internal static string ComputeHash(
            List<ModelSpec> models, string importance,
            bool consistency, string consistencyScope, string? consistencyModelId,
            IEnumerable<(string key, string en, string cn)> entries)
        {
            var modelsStr  = models.Select(m => m.UniqueId).OrderBy(x => x).Connect(separator: "|");
            var entriesStr = entries.Select(e => $"{e.key}\t{e.en}\t{e.cn}").Connect(separator: "\n");
            var raw        = $"{modelsStr}|{importance}|{(consistency ? 1 : 0)}|{consistencyScope}|{consistencyModelId ?? ""}|{entriesStr}";
            var bytes      = SHA256.HashData(raw.ToUTF8Bytes());
            return Convert.ToHexString(bytes)[..24].ToLowerInvariant();
        }

        internal static async Task<ReviewFrontendDisplay?> TryLoad(string hash)
        {
            var path = Path.Combine(CacheDir, $"{hash}.json");
            if (!File.Exists(path)) return null;
            try
            {
                var json   = await File.ReadAllTextAsync(path);
                var cached = json.JsonDeserialize<CacheFile>(_jsonOpts);
                if (cached == null) return null;
                if (DateTime.UtcNow - cached.CachedAt > CacheTtl)
                {
                    Log.Information("Cache expired for hash={Hash}", hash);
                    return null;
                }
                return cached.Result;
            }
            catch (Exception e)
            {
                Log.Warning(e, "Failed to read cache {Hash}", hash);
                return null;
            }
        }

        /// <summary>Load a cache entry by hash, skipping TTL check (for historical viewing).</summary>
        internal static async Task<ReviewFrontendDisplay?> LoadByHash(string hash)
        {
            var path = Path.Combine(CacheDir, $"{hash}.json");
            if (!File.Exists(path)) return null;
            try
            {
                var json   = await File.ReadAllTextAsync(path);
                var cached = json.JsonDeserialize<CacheFile>(_jsonOpts);
                return cached?.Result;
            }
            catch (Exception e)
            {
                Log.Warning(e, "Failed to read cache {Hash}", hash);
                return null;
            }
        }

        /// <summary>List history entries for a specific pr+mod, sorted newest-first. Uses SQLite index.</summary>
        internal static async Task<List<CacheHistoryEntry>> ListHistory(ChristinaDbContext db, int pr, string mod, string? currentContentHash)
        {
            var rows = await db.LlmReviewCacheIndexes
                .Where(r => r.Pr == pr && r.Mod == mod)
                .OrderByDescending(r => r.CachedAt)
                .ToListAsync();

            return rows.Select(r =>
            {
                string[] models;
                try { models = r.Models.JsonDeserialize<string[]>() ?? Array.Empty<string>(); }
                catch { models = Array.Empty<string>(); }
                var isStale = currentContentHash != null && r.ContentHash != null && r.ContentHash != currentContentHash;
                return new CacheHistoryEntry(r.Hash, r.CachedAt, models, r.Importance, r.Consistency, isStale);
            }).ToList();
        }

        internal static async Task Save(
            ChristinaDbContext db,
            string hash, ReviewFrontendDisplay display,
            int pr, string mod, List<ModelSpec> models, string importance, bool consistency, string contentHash)
        {
            try
            {
                Directory.CreateDirectory(CacheDir);
                var now = DateTime.UtcNow;
                var file = new CacheFile
                {
                    CachedAt    = now,
                    Pr          = pr,
                    Mod         = mod,
                    Models      = models.Select(m => m.UniqueId).ToArray(),
                    Importance  = importance,
                    Consistency = consistency,
                    ContentHash = contentHash,
                    Result      = display
                };
                var path = Path.Combine(CacheDir, $"{hash}.json");
                var tempPath = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
                await File.WriteAllTextAsync(tempPath, file.ToJsonString(_jsonOpts));
                File.Move(tempPath, path, overwrite: true);

                // Upsert index row
                var existing = await db.LlmReviewCacheIndexes.FirstOrDefaultAsync(r => r.Hash == hash);
                if (existing == null)
                {
                    db.LlmReviewCacheIndexes.Add(new LlmReviewCacheIndex
                    {
                        Hash        = hash,
                        Pr          = pr,
                        Mod         = mod,
                        CachedAt    = now,
                        Models      = models.Select(m => m.UniqueId).ToArray().ToJsonString(),
                        Importance  = importance,
                        Consistency = consistency,
                        ContentHash = contentHash
                    });
                }
                else
                {
                    existing.CachedAt    = now;
                    existing.ContentHash = contentHash;
                }
                await db.SaveChangesAsync();
            }
            catch (Exception e)
            {
                Log.Warning(e, "Failed to write cache hash={Hash}", hash);
            }
        }
    }
}
