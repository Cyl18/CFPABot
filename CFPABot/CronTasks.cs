using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using CFPABot.Christina.Backend;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Serilog;

namespace CFPABot;

public class CronTask
{
    private static readonly string CacheDir = Path.Combine("config", "llm-review-cache");

    /// <summary>
    /// Deletes cache files in config/llm-review-cache that are older than 30 days (based on cachedAt).
    /// Runs daily at 03:00 UTC.
    /// </summary>
    public static async Task RunLlmCacheCleanup(ChristinaDbContext db)
    {
        var ttl = TimeSpan.FromDays(30);
        var now = DateTime.UtcNow;
        var files = Directory.Exists(CacheDir)
            ? Directory.GetFiles(CacheDir, "*.json")
            : Array.Empty<string>();

        // First pass: collect metadata and group by (pr, mod) to find protected (newest) file per group
        var fileMeta = new List<(string path, DateTime cachedAt, string prStr, string modStr)>();
        foreach (var file in files)
        {
            try
            {
                var json = await File.ReadAllTextAsync(file);
                using var doc = JsonDocument.Parse(json);
                var root = doc.RootElement;
                DateTime cachedAt = default;
                root.TryGetProperty("cachedAt", out var cachedAtEl);
                cachedAtEl.TryGetDateTime(out cachedAt);
                var prStr  = root.TryGetProperty("pr",  out var prEl)  ? prEl.GetInt32().ToString() : null;
                var modStr = root.TryGetProperty("mod", out var modEl) ? modEl.GetString()          : null;
                fileMeta.Add((file, cachedAt, prStr, modStr));
            }
            catch (Exception ex)
            {
                Log.Warning(ex, "CronTask: failed to read cache file {File}", file);
                fileMeta.Add((file, default, null, null));
            }
        }

        // Determine protected files: the newest file per (pr, mod) group (null pr/mod = no protection)
        var protectedPaths = new HashSet<string>();
        var groups = fileMeta
            .Where(f => f.prStr != null && f.modStr != null)
            .GroupBy(f => (f.prStr, f.modStr));
        foreach (var group in groups)
        {
            var newest = group.OrderByDescending(f => f.cachedAt).First();
            protectedPaths.Add(newest.path);
        }

        // Second pass: delete expired files that are not protected
        int deleted = 0;
        foreach (var entry in fileMeta)
        {
            if (protectedPaths.Contains(entry.path)) continue;
            if (entry.cachedAt == default || now - entry.cachedAt > ttl)
            {
                try
                {
                    File.Delete(entry.path);
                    deleted++;
                }
                catch (Exception ex)
                {
                    Log.Warning(ex, "CronTask: failed to delete cache file {File}", entry.path);
                }
            }
        }

        var orphanedRows = (await db.LlmReviewCacheIndexes.ToListAsync())
            .Where(r => !File.Exists(Path.Combine(CacheDir, $"{r.Hash}.json")))
            .ToList();

        if (orphanedRows.Count > 0)
        {
            db.LlmReviewCacheIndexes.RemoveRange(orphanedRows);
            await db.SaveChangesAsync();
            Log.Information("CronTask: deleted {Count} orphaned LLM cache index rows", orphanedRows.Count);
        }

        if (deleted > 0)
            Log.Information("CronTask: deleted {Count} expired LLM cache files", deleted);
    }

    /// <summary>Runs the cleanup task every day at 03:00 UTC. Stops cleanly when <paramref name="ct"/> is cancelled.</summary>
    public static async Task RunDailyCleanupLoop(IServiceScopeFactory scopeFactory, CancellationToken ct = default)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                var now = DateTime.UtcNow;
                var next = new DateTime(now.Year, now.Month, now.Day, 3, 0, 0, DateTimeKind.Utc);
                if (next <= now) next = next.AddDays(1);
                var delay = next - now;
                await Task.Delay(delay, ct);
                if (ct.IsCancellationRequested) break;
                using var scope = scopeFactory.CreateScope();
                var db = scope.ServiceProvider.GetRequiredService<ChristinaDbContext>();
                await RunLlmCacheCleanup(db);
            }
            catch (OperationCanceledException) { break; }
            catch (Exception ex)
            {
                Log.Error(ex, "CronTask: daily cleanup failed");
                try { await Task.Delay(TimeSpan.FromHours(1), ct); } catch (OperationCanceledException) { break; }
            }
        }
    }
}
