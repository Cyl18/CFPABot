﻿using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using CFPABot.Resources;
using GammaLibrary.Extensions;
using Octokit;
using Serilog;

namespace CFPABot.Utils
{
    public class KeyAnalyzer
    {
        public static bool Analyze(string modid, string enfile, string cnfile, MCVersion version,
            StringBuilder messageStringBuilder, StringBuilder reportStringBuilder)
        {
            return version switch
            {
                MCVersion.v1122 => LangChecker(modid, enfile, cnfile, messageStringBuilder, reportStringBuilder, version),
                _ => JsonChecker(modid, enfile, cnfile, messageStringBuilder, reportStringBuilder, version)
            };
        }

        static bool JsonChecker(string modid, string enfile, string cnfile, StringBuilder sb,
            StringBuilder reportStringBuilder, MCVersion mcVersion)
        {
            try
            {
                JsonDocument en, cn;
                try
                {
                    en = JsonDocument.Parse(enfile, new JsonDocumentOptions() { CommentHandling = JsonCommentHandling.Skip });
                    cn = JsonDocument.Parse(cnfile, new JsonDocumentOptions() { CommentHandling = JsonCommentHandling.Skip });
                }
                catch (Exception e)
                {
                    sb.AppendLine(string.Format(Locale.Check_Key_JsonSyntaxError, modid, mcVersion.ToVersionString(), e.Message));
                    reportStringBuilder.AppendLine($"{e}");
                    return true;
                }

                if (!en.RootElement.EnumerateObject().Any())
                {
                    sb.AppendLine(string.Format(Locale.Check_Key_JsonEnFileEmpty, modid, mcVersion.ToVersionString()));
                    return true;
                }

                if (!cn.RootElement.EnumerateObject().Any())
                {
                    sb.AppendLine(string.Format(Locale.Check_Key_JsonCnFileEmpty, modid, mcVersion.ToVersionString()));
                    return true;
                }

                var ens = en.RootElement.EnumerateObject().Select(p => p.Name).Where(k => !k.StartsWith("_")).ToHashSet();
                var cns = cn.RootElement.EnumerateObject().Select(p => p.Name).Where(k => !k.StartsWith("_")).ToHashSet();
                return AnalyzeCore(ens, cns, modid, sb, reportStringBuilder, mcVersion, enfile, cnfile);
            }
            catch (Exception e)
            {
                sb.AppendLine(string.Format(Locale.Check_Key_Error, modid, mcVersion.ToVersionString(), e.Message));
                reportStringBuilder.AppendLine($"语言文件检查失败： {e}");
                return false;
            }
        }


        static bool LangChecker(string modid, string enfile, string cnfile, StringBuilder sb,
            StringBuilder reportSb, MCVersion version)
        {
            if (enfile.IsNullOrWhiteSpace())
            {
                sb.AppendLine(string.Format(Locale.Check_Key_LangEnFileEmpty, modid, version.ToVersionString()));
                return false;
            }
            if (cnfile.IsNullOrWhiteSpace())
            {
                sb.AppendLine(string.Format(Locale.Check_Key_LangCnFileEmpty, modid, version.ToVersionString()));
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
                modid, sb, reportSb, version, enfile, cnfile
                );
        }

        static bool AnalyzeCore(HashSet<string> enKeys, HashSet<string> cnKeys, string modid, StringBuilder sb,
            StringBuilder reportSb, MCVersion mcVersion, string enfile, string cnfile)
        {
            reportSb.AppendLine($"{modid}-{mcVersion.ToVersionString()} 中文语言文件共有 {cnKeys.Count} 个 Key； 英文语言文件共有 {enKeys.Count} 个 Key");
            var enExcept = new HashSet<string>(enKeys); // en 比 cn 多的
            enExcept.ExceptWith(cnKeys);
            var cnExcept = new HashSet<string>(cnKeys); // cn 比 en 多的
            cnExcept.ExceptWith(enKeys);
            if (enExcept.Count == 0 && cnExcept.Count == 0)
            {
                sb.AppendLine(string.Format(Locale.Check_Key_Success, modid, mcVersion.ToVersionString()));
                return false;
            }

            sb.AppendLine(string.Format(Locale.Check_Key_NotCorrespond, modid, mcVersion.ToVersionString()));

            if (enExcept.Count > 0)
            {
                sb.AppendLine($"- 英文语言文件有 {enExcept.Count} 个 Key 多于中文语言文件。例如：\n{enExcept.Take(4).Select(f => $"  - 行 {(enfile.Split('\n').ToList().FindIndex(l => l.Contains(f)) + 1)}-`{f}`").Connect("\n")}");
                reportSb.AppendLine($"英文多于中文的 Key: \n{enExcept.Select(k => $"    {k}\n").Connect("")}");
            }

            if (cnExcept.Count > 0)
            {
                sb.AppendLine($"- 中文语言文件有 {cnExcept.Count} 个 Key 多于英文语言文件。例如：\n{cnExcept.Take(4).Select(f => $"  - 行 {(cnfile.Split('\n').ToList().FindIndex(l => l.Contains(f)) + 1)}-`{f}`").Connect("\n")}");
                reportSb.AppendLine($"中文多于英文的 Key: \n{cnExcept.Select(k => $"    {k}\n").Connect("")}");
            }

            reportSb.AppendLine();
            sb.AppendLine();
            return true;
        }
        
    }
}
