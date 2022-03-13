using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using GammaLibrary.Extensions;

namespace CFPABot.Utils
{
    public class ModKeyAnalyzer
    {
        public static bool Analyze(string modid, string enfile, string cnfile, MCVersion version,
            StringBuilder messageStringBuilder, StringBuilder reportStringBuilder, string downloadModName)
        {
            return version switch
            {
                MCVersion.v1122 => LangChecker(modid, enfile, cnfile, messageStringBuilder, reportStringBuilder, version, downloadModName),
                MCVersion.v116 or MCVersion.v118 => JsonChecker(modid, enfile, cnfile, messageStringBuilder, reportStringBuilder, version, downloadModName),
                _ => false
            };
        }

        static bool JsonChecker(string modid, string enfile, string cnfile, StringBuilder sb,
            StringBuilder reportStringBuilder, MCVersion mcVersion, string downloadModName)
        {
            try
            {
                JsonDocument en, cn;
                try
                {
                    en = JsonDocument.Parse(enfile);
                    cn = JsonDocument.Parse(cnfile);
                }
                catch (Exception e)
                {
                    sb.AppendLine($"❌ {modid}-{mcVersion.ToVersionString()} 的语言文件中有 JSON 语法错误：{e.Message}");
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
                return AnalyzeCore(ens, cns, modid, sb, reportStringBuilder, mcVersion, downloadModName, enfile, cnfile);
            }
            catch (Exception e)
            {
                sb.AppendLine($"ℹ {modid}-{mcVersion.ToVersionString()} 的语言文件检查失败：{e.Message}");
                reportStringBuilder.AppendLine($"语言文件检查失败： {e}");
                return false;
            }
        }


        static bool LangChecker(string modid, string enfile, string cnfile, StringBuilder sb,
            StringBuilder reportSb, MCVersion version, string downloadModName)
        {
            if (enfile.IsNullOrWhiteSpace())
            {
                return false;
            }
            if (cnfile.IsNullOrWhiteSpace())
            {
                return false;
            }

            return AnalyzeCore(
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
                modid, sb, reportSb, version, downloadModName, enfile, cnfile
                );
        }

        static bool AnalyzeCore(HashSet<string> enKeys, HashSet<string> cnKeys, string modid, StringBuilder sb,
            StringBuilder reportSb, MCVersion mcVersion, string downloadModName, string enfile, string cnfile)
        {
            reportSb.AppendLine($"{modid}-{mcVersion.ToVersionString()} 模组内语言文件共有 {cnKeys.Count} 个 Key；");
            var enExcept = new HashSet<string>(enKeys); // en 比 cn 多的
            enExcept.ExceptWith(cnKeys);
            var cnExcept = new HashSet<string>(cnKeys); // cn 比 en 多的
            cnExcept.ExceptWith(enKeys);
            if (enExcept.Count == 0 && cnExcept.Count == 0)
            {
                sb.AppendLine($"ℹ {modid}-{mcVersion.ToVersionString()} 模组内语言文件验证通过。");
                return false;
            }

            sb.AppendLine($"⚠ 警告：PR 中 {modid}-{mcVersion.ToVersionString()} 的英文语言文件与最新模组 `{downloadModName}` 内的英文语言文件不对应。这可能是由于机器人自动获取的模组不是最新，语言文件中包含扩展模组，或所提交的语言文件来自模组源代码仓库。");

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
