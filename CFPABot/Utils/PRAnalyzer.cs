using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using CFPABot.DiffEngine;
using DiffPatch.Data;

namespace CFPABot.Utils
{
    public record ModInfo(string CurseForgeID, string ModDomain, MCVersion Version);

    public static class PRAnalyzer
    {
        public static List<ModInfo> Run(FileDiff[] diffs, bool langOnly = false)
        {
            var seen = new HashSet<(string, string, MCVersion)>();
            var infos = new List<ModInfo>();
            foreach (var fileDiff in diffs)
            {
                var names = fileDiff.To?.Split('/') ?? Array.Empty<string>();
                if (names.Length < 7) continue; // 超级硬编码
                if (names[0] != "projects") continue;
                
                var cfid = names[2];
                var version = names[3].ToMCStandardVersion();
                var domain = names[4]; // 这里不需要管是不是改的是语言文件 只需要看涉及了啥mod
                if (cfid == "1UNKNOWN") continue;
                if (langOnly && names[5] != "lang") continue;
                
                if (seen.Add((domain, cfid, version)))
                {
                    infos.Add(new ModInfo(cfid, domain, version));
                }
            }

            return infos;
        }

        public static List<ModPath> RunBleedingEdge(FileDiff[] diffs)
        {
            var paths = new HashSet<ModPath>();
            foreach (var fileDiff in diffs)
            {
                var names = fileDiff.To?.Split('/') ?? Array.Empty<string>();
                if (names.Length < 7) continue;
                if (names[0] != "projects") continue;

                paths.Add(new ModPath(fileDiff.To));
            }
            return paths.ToList();
        }


    }
}
