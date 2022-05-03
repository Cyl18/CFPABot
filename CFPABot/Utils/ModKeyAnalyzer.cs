using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using CFPABot.Resources;
using GammaLibrary.Extensions;

namespace CFPABot.Utils
{
    public class ModInfoForCheck
    {
        public ModInfoForCheck(string modid, MCVersion version, string downloadModName, string curseForgeSlug)
        {
            Modid = modid;
            Version = version;
            DownloadModName = downloadModName;
            CurseForgeSlug = curseForgeSlug;
        }

        public string Modid { get; set; }
        public MCVersion Version { get; set; }
        public string DownloadModName { get; set; }
        public string CurseForgeSlug { get; set; }
    }

    public class ModKeyAnalyzer
    {
        public static bool Analyze(ModInfoForCheck modInfoForCheck, string enfile, string cnfile,
            StringBuilder messageStringBuilder, StringBuilder reportStringBuilder)
        {
            return modInfoForCheck.Version switch
            {
                MCVersion.v1122 => LangChecker(modInfoForCheck, enfile, cnfile, messageStringBuilder, reportStringBuilder),
                _ => JsonChecker(modInfoForCheck, enfile, cnfile, messageStringBuilder, reportStringBuilder)
            };
        }

        static bool JsonChecker(ModInfoForCheck modInfoForCheck, string enfile, string cnfile, StringBuilder sb,
            StringBuilder reportStringBuilder)
        {
            try
            {
                JsonDocument en, cn;
                try
                {
                    en = JsonDocument.Parse(enfile, new JsonDocumentOptions() { CommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true });
                    cn = JsonDocument.Parse(cnfile, new JsonDocumentOptions() { CommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true });
                }
                catch (Exception e)
                {
                    sb.AppendLine(string.Format(Locale.Check_ModKey_JsonSyntaxError, modInfoForCheck.Modid, modInfoForCheck.Version.ToVersionString(), e.Message));
                    reportStringBuilder.AppendLine($"{e}");
                    return true;
                }

                if (!en.RootElement.EnumerateObject().Any())
                {
                    return true;
                }

                if (!cn.RootElement.EnumerateObject().Any())
                {
                    return true;
                }

                var ens = en.RootElement.EnumerateObject().Select(p => p.Name).Where(k => !k.StartsWith("_")).ToHashSet();
                var cns = cn.RootElement.EnumerateObject().Select(p => p.Name).Where(k => !k.StartsWith("_")).ToHashSet();
                return AnalyzeCore(modInfoForCheck, ens, cns, sb, reportStringBuilder, enfile, cnfile);
            }
            catch (Exception e)
            {
                sb.AppendLine(string.Format(Locale.Check_ModKey_Error, modInfoForCheck.Modid, modInfoForCheck.Version.ToVersionString(), e.Message));
                reportStringBuilder.AppendLine($"语言文件检查失败： {e}");
                return false;
            }
        }


        static bool LangChecker(ModInfoForCheck modInfoForCheck, string enfile, string cnfile, StringBuilder sb,
            StringBuilder reportSb)
        {
            if (enfile.IsNullOrWhiteSpace())
            {
                return false;
            }
            if (cnfile.IsNullOrWhiteSpace())
            {
                return false;
            }

            return AnalyzeCore(modInfoForCheck,
                enfile
                    .Split("\n")
                    .Select(line => line.Trim())                // Trim
                    .Where(line => !line.IsNullOrWhiteSpace())  // 移除空行
                    .Where(line => !line.StartsWith("#"))       // 移除注释
                    .Where(line => line.Contains("="))          // 保证有等号
                    .Select(line => line.Split("=").First())    // 提取 Key
                    .ToHashSet(),
                cnfile
                    .Split("\n")
                    .Select(line => line.Trim())                // Trim
                    .Where(line => !line.IsNullOrWhiteSpace())  // 移除空行
                    .Where(line => !line.StartsWith("#"))       // 移除注释
                    .Where(line => line.Contains("="))          // 保证有等号
                    .Select(line => line.Split("=").First())    // 提取 Key
                    .ToHashSet(),
                 sb, reportSb, enfile, cnfile
                );
        }

        static bool AnalyzeCore(ModInfoForCheck modInfoForCheck, HashSet<string> enKeys, HashSet<string> cnKeys, StringBuilder sb,
            StringBuilder reportSb, string enfile, string cnfile)
        {
            reportSb.AppendLine($"{modInfoForCheck.Modid}-{modInfoForCheck.Version.ToVersionString()} 模组内语言文件共有 {cnKeys.Count} 个 Key；");
            var enExcept = new HashSet<string>(enKeys); // en 比 cn 多的
            enExcept.ExceptWith(cnKeys);
            var cnExcept = new HashSet<string>(cnKeys); // cn 比 en 多的
            cnExcept.ExceptWith(enKeys);
            if (enExcept.Count == 0 && cnExcept.Count == 0)
            {
                sb.AppendLine(string.Format(Locale.Check_ModKey_Success, modInfoForCheck.Modid, modInfoForCheck.Version.ToVersionString()));
                return false;
            }

            // 这可能是由于机器人自动获取的模组不是最新，语言文件中包含扩展模组，或所提交的语言文件来自模组源代码仓库。可以点击上方的对比按钮来进行更加详细的对比。
            sb.AppendLine(string.Format(Locale.Check_ModKey_NotCorrespond, modInfoForCheck.Modid, modInfoForCheck.Version.ToVersionString(), modInfoForCheck.DownloadModName, modInfoForCheck.CurseForgeSlug, modInfoForCheck.Version.ToVersionString()));

            if (enExcept.Count > 0)
            {
                sb.AppendLine($"- 英文语言文件有 {enExcept.Count} 个 Key 多于模组内语言文件。例如：\n{enExcept.Take(4).Select(f => $"  - 行 {(enfile.Split('\n').ToList().FindIndex(l => l.Contains(f)) + 1)}-`{f}`").Connect("\n")}");
                reportSb.AppendLine($"英文多于模组内的 Key: \n{enExcept.Select(k => $"    {k}\n").Connect("")}");
            }

            if (cnExcept.Count > 0)
            {
                sb.AppendLine($"- 模组内语言文件有 {cnExcept.Count} 个 Key 多于英文语言文件。例如：\n{cnExcept.Take(4).Select(f => $"  - 行 {(cnfile.Split('\n').ToList().FindIndex(l => l.Contains(f)) + 1)}-`{f}`").Connect("\n")}");
                reportSb.AppendLine($"模组内多于英文的 Key: \n{cnExcept.Select(k => $"    {k}\n").Connect("")}");
            }

            reportSb.AppendLine();
            sb.AppendLine();
            return true;
        }
        
    }
}
