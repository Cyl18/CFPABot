using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using CFPABot.DiffEngine;
using CFPABot.Utils;
using GammaLibrary.Extensions;
using Microsoft.AspNetCore.DataProtection.KeyManagement;
using Octokit;
using Serilog;

namespace CFPABot.PRData;

public class PRDataManager
{
    // string is mod slug
    public static Dictionary<string, HashSet<(int prid, ModVersion modVersion)>> Relation { get; private set; }
    public static int RefreshCount
    {
        get => Thread.VolatileRead(ref _refreshCount);
    }
    private static int _refreshCount = 0;
    const string CacheDir = "config/pr_cache";

    public static async Task Init()
    {
        var prs = await GitHub.Instance.PullRequest.GetAllForRepository(Constants.RepoID);

        await Parallel.ForEachAsync(prs, new ParallelOptions {MaxDegreeOfParallelism = 3},async (pr, token) =>
        {
            await RefreshCore(pr);
        });

        var localPRs = Directory.GetFiles(CacheDir).Select(Path.GetFileNameWithoutExtension).Select(x => x.ToInt());
        
        foreach (var localPR in localPRs)
        {
            if (prs.All(x => x.Number != localPR))
            {
                PRFilesData.Remove(localPR);
            }
        }
        
        RebuildRelation();
        
    }
    
    public static async Task Refresh(int prid)
    {
        Interlocked.Increment(ref _refreshCount);
        try
        {
            var pr = await GitHub.GetPullRequest(prid);
            await RefreshCore(pr, true);

        }
        catch (Exception e)
        {
            Log.Error(e, "Refresh PR");
        }
        finally
        {
            Interlocked.Decrement(ref _refreshCount);
        }
    }
    public static string GetHeadSha(int prid)
    {
        var (prId, headHash, pullRequestFileExes) = PRFilesData.TryGet(prid);
        return headHash;

    }
    
    public static (string cn, string en) GetPath(int prid, ModVersion version, string slug)
    {
        var (prId, headHash, pullRequestFileExes) = PRFilesData.TryGet(prid);
        foreach (var pullRequestFileEx in pullRequestFileExes)
        {
            try
            {
                if (new LangFilePath(pullRequestFileEx.FileName).ModPath.ModVersion == version &&
                    new LangFilePath(pullRequestFileEx.FileName).ModPath.CurseForgeSlug == slug)
                {
                    var p = pullRequestFileExes.Where(x =>
                        x.FileName.Contains("/"+version.ToVersionDirectory()+"/") &&
                        x.FileName.Contains("/"+slug+"/"));
                    return (p.First(x => x.FileName.Contains("zh_cn")).RawUrl,
                        p.First(x => x.FileName.Contains("en_us")).RawUrl);
                }
                

            }
            catch (Exception e)
            {
            }
            
        }

        return (null, null);
    }
    public static string GetModID(int prid, ModVersion version, string slug)
    {
        var (prId, headHash, pullRequestFileExes) = PRFilesData.TryGet(prid);
        foreach (var pullRequestFileEx in pullRequestFileExes)
        {
            try
            {
                var langFilePath = new LangFilePath(pullRequestFileEx.FileName);
                if (langFilePath.ModPath.ModVersion == version && langFilePath.ModPath.CurseForgeSlug == slug)
                {
                    return langFilePath.ModPath.ModDomain;
                }
            }
            catch (Exception e)
            {
            }
            
        }

        return null;
    }
    static async Task RefreshCore(PullRequest pr, bool rebuild = false)
    {
        var prid = pr.Number;
        if (pr.State.Value == ItemState.Closed)
        {
            PRFilesData.Remove(prid);
            return;
        }

        var prFilesData = PRFilesData.TryGet(prid);
        if (prFilesData == null || pr.Head.Sha != prFilesData.HeadHash)
        {
            Log.Information($"Updating PR Files Cache: {prid}");
            var pullRequestFiles = await GitHub.GetPullRequestFiles(prid);
            new PRFilesData(prid, pr.Head.Sha, pullRequestFiles.Select(x => new PullRequestFileEx()
            {
                FileName = x.FileName,
                Changes = x.Changes,
                Additions = x.Additions,
                BlobUrl = x.BlobUrl,
                ContentsUrl = x.ContentsUrl,
                Deletions = x.Deletions,
                Patch = x.Patch,
                PreviousFileName = x.PreviousFileName,
                RawUrl = x.RawUrl,
                Sha = x.Sha,
                Status = x.Status
            }).ToArray()).Save();
            if (rebuild)
            {
                RebuildRelation();
            }
        }
    }

    public static void RebuildRelation()
    {
        var sw = Stopwatch.StartNew();
        var d = new Dictionary<string, HashSet<(int prid, ModVersion modVersion)>>();
        
        
        var localPRs = Directory.GetFiles(CacheDir).Select(Path.GetFileNameWithoutExtension).Select(x => x.ToInt());
        foreach (var localPR in localPRs.Select(x => PRFilesData.TryGet(x)).Where(x => x is not null))
        {
            foreach (var file in localPR.Files.Where(x => x.FileName != null && x.FileName.StartsWith("projects") && x.FileName.Count(c => c == '/') > 5))
            {
                try
                {
                    var modPath = new ModPath(file.FileName);
                    var set = d.GetOrCreate(modPath.CurseForgeSlug, () => new HashSet<(int prid, ModVersion modVersion)>());
                    set.Add((localPR.PRId, modPath.ModVersion));
                }
                catch (Exception e)
                {
                    Log.Information(e.ToString());
                }
            }
        }

        Relation = d;


        Log.Information($"Rebuild pr relation took {sw.Elapsed.TotalSeconds:F2}s");

    }
}

public class PullRequestFileEx
{
    public string Sha { get; set; }
    public string FileName { get; set; }
    public string Status { get; set; }
    public int Additions { get; set; }
    public int Deletions { get; set; }
    public int Changes { get; set; }
    public string BlobUrl { get; set; }
    public string RawUrl { get; set; }
    public string ContentsUrl { get; set; }
    public string Patch { get; set; }
    public string PreviousFileName { get; set; }
}

public record PRFilesData(int PRId, string HeadHash, PullRequestFileEx[] Files)
{
    const string CacheDir = "config/pr_cache";
    static readonly object locker = new();

    public void Save()
    {
        lock (locker)
        {
            var path = Path.Combine(CacheDir, $"{PRId}.json");
            File.WriteAllText(path, this.ToJsonString());   
        }
    }

    public static void Remove(int prid)
    {
        var path = Path.Combine(CacheDir, $"{prid}.json");

        lock (locker)
            if (File.Exists(path)) File.Delete(path);
    }
    
    public static PRFilesData TryGet(int PRId)
    {
        try
        {
            lock (locker)
            {
                var path = Path.Combine(CacheDir, $"{PRId}.json");
                if (!File.Exists(path)) return null;
                return File.ReadAllText(path).JsonDeserialize<PRFilesData>();
                
            }
        }
        catch (Exception)
        {
        }

        return null;
    }
}