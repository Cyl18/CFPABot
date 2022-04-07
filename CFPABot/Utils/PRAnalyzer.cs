using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using DiffPatch.Data;

namespace CFPABot.Utils
{
    public record ModInfo(string CurseForgeID, string ModDomain, MCVersion Version);

    public static class PRAnalyzer
    {
        public static List<ModInfo> Run(FileDiff[] diffs, bool langOnly = false)
        {
            var infos = new List<ModInfo>();
            foreach (var fileDiff in diffs)
            {
                var names = fileDiff.To.Split('/');
                if (names.Length < 7) continue; // 超级硬编码
                if (names[0] != "projects") continue;
                
                var version = names[1].ToMCStandardVersion();
                var cfid = names[3];
                var domain = names[4]; // 这里不需要管是不是改的是语言文件 只需要看涉及了啥mod
                if (cfid == "1UNKNOWN") continue;
                if (langOnly && names[5] != "lang") continue;
                
                if (!infos.Exists(i => i.ModDomain == domain && i.Version == version && i.CurseForgeID == cfid)) // O(N^2)是吧 我不管了哈哈
                {
                    infos.Add(new ModInfo(cfid, domain, version));
                }
            }

            return infos;
        }
    }
}
