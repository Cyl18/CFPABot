using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using CFPABot.DiffEngine;
using CFPABot.Utils;
using GammaLibrary.Extensions;
using Octokit;
using Serilog;

namespace CFPABot.PRData;

public class PRDataManager
{
    // string is mod slug
    public static Dictionary<string, HashSet<(int prid, ModVersion modVersion)>> Relation { get; private set; }

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
        var pr = await GitHub.GetPullRequest(prid);
        await RefreshCore(pr, true);
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
            new PRFilesData(prid, pr.Head.Sha, pullRequestFiles.ToArray()).Save();
            if (rebuild)
            {
                RebuildRelation();
            }
        }
    }

    static void RebuildRelation()
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
        File.WriteAllText("config/teoitjiojo.json", d.ToJsonString());

    }
}

public record PRFilesData(int PRId, string HeadHash, PullRequestFile[] Files)
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