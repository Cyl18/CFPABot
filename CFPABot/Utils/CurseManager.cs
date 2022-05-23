﻿using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using System.Web;
using CFPABot.Models.A;
using CFPABot.Resources;
using ForgedCurse;
using ForgedCurse.Json;
using GammaLibrary;
using GammaLibrary.Extensions;
using Serilog;

namespace CFPABot.Utils
{
    public static class CurseManager
    {
        public static async Task<string> GetThumbnailText(Addon addon)
        {
            try
            {
                var url = addon.Attachments.FirstOrDefault(a => a.Default)?.ThumbnailUrl;
                if (url == null) return "✨";

                await using var stream = await new HttpClient().GetStreamAsync(url);
                var fileName = $"{url.Split("/").Last()}";
                await using var fs = File.OpenWrite($"wwwroot/{fileName}");
                await stream.CopyToAsync(fs);
                return $"<image src=\"https://cfpa.cyan.cafe/static/{fileName}\" width=\"32\"/>";
            }
            catch (Exception)
            {
                return "✨";
            }
        }

        // 因为那个ForgeCursed api不全所以还得手动请求一次..
        // 之后可以重构为全部用这个
        public static async Task<AddonModel> GetAddonModel(Addon addon)
        {
            var s = await Download.CurseForgeString($"https://addons-ecs.forgesvc.net/api/v2/addon/{addon.Identifier}");
            return s.JsonDeserialize<AddonModel>();
        }

        public static string GetDownloadsText(Addon addon, MCVersion[] versions)
        {
            var sb = new StringBuilder();
            try
            {
                sb.Append("<details> <summary>最新模组文件</summary>");
                var p = new HashSet<int>();
                foreach (var file in addon.Files.OrderByDescending(s => new Version(s.GameVersion)))
                {
                    if (p.Contains(file.FileId)) continue;

                    p.Add(file.FileId);
                    if (versions.Any(v => file.GameVersion.StartsWith(v.ToStandardVersionString())))
                    {
                        sb.Append($"[**{file.GameVersion}**/{(file.FileType switch { 2 => "🅱 ", 3 => "🅰 ", 1 => "", _ => throw new ArgumentOutOfRangeException()})}{file.FileName.Replace('[', '*').Replace(']', '*').Replace(".jar", "")}]({GetDownloadUrl(file)})<br />");
                    }
                }
                sb.Append("</details>");
            }
            catch (Exception e)
            {
                sb.Append($"❌ {e.Message}");
                Log.Error(e, $"GetDownloadsText: {addon.Slug}");
            }

            return sb.ToString();
        }
        

        public static async Task<string> GetModRepoLinkText(Addon addon, ModInfo[] infos)
        {
            var sb = new StringBuilder();
            try
            {
                sb.Append("<details> <summary>语言文件链接</summary>");
                var (curseForgeID, modDomain, mcVersion) = infos.First();
                
                foreach (var v in Enum.GetValues<MCVersion>().Select(n => n.ToVersionString()))
                {
                    foreach (var file in v == "1.12.2" ? new[] { "zh_cn.lang", "zh_CN.lang", "en_us.lang", "en_US.lang" } : new[] { "zh_cn.json", "zh_CN.json", "en_us.json", "en_US.json" })
                    {
                        var link = $"https://raw.githubusercontent.com/CFPAOrg/Minecraft-Mod-Language-Package/main/projects/{v}/assets/{curseForgeID}/{modDomain}/lang/{file}";
                        if (await LinkExists(link))
                        {
                            sb.Append($"[{v}/{file}](https://github.com/CFPAOrg/Minecraft-Mod-Language-Package/blob/main/projects/{v}/assets/{curseForgeID}/{modDomain}/lang/{file}) <br/>");
                        }
                    }

                }

                sb.Append("</details>");
            }
            catch (Exception e)
            {
                sb.Append($"❌ {e.Message}");
                Log.Error(e, $"GetModRepoLinkText: {addon.Slug}");
            }

            return sb.ToString();
        }

        static HttpClient hc = new HttpClient();
        static async Task<bool> LinkExists(string link)
        {
            try
            {
                var message = await hc.GetAsync(link);
                message.EnsureSuccessStatusCode();
                return true;
            }
            catch (HttpRequestException e)
            {
                if (e.StatusCode != HttpStatusCode.NotFound)
                    Log.Warning($"LinkExists returned unusual status code: {e.StatusCode}");
                return false;
            }
        }

        public static async Task<string> GetRepoText(Addon addon)
        {
            var s = JsonDocument.Parse(await Download.CurseForgeString($"https://addons-ecs.forgesvc.net/api/v2/addon/{addon.Identifier}/"));
            try
            {
                var url = s.RootElement.GetProperty("sourceUrl").GetString();
                return url == null ? ":mag:无源代码" : $"[:mag: 源代码]({url})&nbsp;&nbsp;";
            }
            catch (Exception)
            {
                return ":mag:无源代码";
            }
        }

        public static async Task<string> GetRepoText(AddonModel addon)
        {
            try
            {
                var url = addon.SourceUrl;
                return url.IsNullOrEmpty() ? ":mag:无源代码" : $"[:mag: 源代码]({url})&nbsp;&nbsp;";
            }
            catch (Exception)
            {
                return ":mag:无源代码";
            }
        }

        public static string GetDownloadUrl(GameVersionLatestRelease release)
        {
            var s = release.FileId.ToString();
            return
                $"https://edge.forgecdn.net/files/{s.Substring(0, 4)}/{s.Substring(4, 3).ToInt()}/{(release.FileName.Replace(" ", "%20"))}";
        }

        public static int MapModIDToProjectID(string modid)
        {
            try
            {
                _ = CurseForgeIDMappingManager.UpdateIfRequired();
                lock (ModIDMappingMetadata.Instance)
                {
                    return ModIDMappingMetadata.Instance.Mapping[modid];
                }
            }
            catch (Exception e)
            {
                Log.Error(e, "MapModIDToProjectID");
                throw new CheckException(string.Format(Locale.General_MapModIDToProjectID_Error_1, modid, modid) +
                                         Locale.General_MapModIDToProjectID_Error_2 +
                                         (modid.Any(c => char.IsUpper(c)) ? Locale.General_MapModIDToProjectID_Error_3 : "") +
                                         string.Format(Locale.General_MapModIDToProjectID_Error_4, modid, modid));
            }
        }

        public static Task<Addon> GetAddon(string modid)
        {
            Log.Debug($"获取 Addon: {modid}");
            return new ForgeClient().Addons.RetriveAddon(MapModIDToProjectID(modid));
        }

        public static async Task<string> GetModID(Addon addon, MCVersion? version, bool enforcedLang = false,
            bool connect = true)
        {
            if (version == null) return "未知";
            try
            {
                if (addon.Files.FirstOrDefault(f => f.GameVersion.StartsWith(version.Value.ToStandardVersionString())) is { } file)
                {
                    var fileName = await Download.DownloadFile(GetDownloadUrl(file));
                    await using var fs = FileUtils.OpenFile(fileName);

                    var modids = new ZipArchive(fs).Entries
                        .Where(a => a.FullName.StartsWith("assets"))
                        .Where(a => !enforcedLang || a.FullName.Contains("lang"))
                        .Select(a => a.FullName.Split("/")[1]).Distinct().Where(n => !n.IsNullOrWhiteSpace())
                        .Where(id => id != "minecraft" && id != "icon.png");

                    return connect ? modids
                        .Connect(" \\| ", "*", "*") : modids.First();
                }
            }
            catch (Exception e)
            {
                Log.Error(e, "GetModID 出错");
                return $"未知";
            }
            return "未知";
        }


        public static async Task<string[]> GetModIDForCheck(Addon addon, MCVersion? version)
        {
            if (version == null) return null;
            try
            {
                if (addon.Files.FirstOrDefault(f => f.GameVersion.StartsWith(version.Value.ToStandardVersionString())) is { } file)
                {
                    var fileName = await Download.DownloadFile(GetDownloadUrl(file));
                    await using var fs = FileUtils.OpenFile(fileName);

                    var modids = new ZipArchive(fs).Entries
                        .Where(a => a.FullName.StartsWith("assets"))
                        .Select(a => a.FullName.Split("/")[1]).Distinct().Where(n => !n.IsNullOrWhiteSpace())
                        .Where(id => id != "minecraft")
                        .ToArray();
                    return modids;
                }
            }
            catch (Exception e)
            {
                Log.Error(e, "GetModID 出错");
                return null;
            }

            return null;
        }

        public static async Task<(string[] files, string downloadFileName)> GetModEnFile(Addon addon, MCVersion? version, LangType type)
        {
            if (version == null) return (null, null);
            try
            {
                if (addon.Files.OrderByDescending(f => f.FileId).FirstOrDefault(f => f.GameVersion.StartsWith(version.Value.ToStandardVersionString())) is { } file)
                {
                    var downloadUrl = GetDownloadUrl(file);
                    var (fs, files) = await GetModLangFiles(downloadUrl, type, version == MCVersion.v1122 ? LangFileType.Lang : LangFileType.Json);

                    await using (fs)
                    {
                        return (files.Select(f => f.Open().ReadToEnd()).ToArray(), file.FileName);
                    }
                }
            }
            catch (Exception e)
            {
                Log.Error(e, "GetModID 出错");
                return (null, null);
            }

            return (null, null);
        }

        public static async Task<(Stream, IEnumerable<ZipArchiveEntry>)> GetModLangFiles(string downloadUrl, LangType type, LangFileType fileType)
        {
            var fileName = await Download.DownloadFile(downloadUrl);
            var fs = FileUtils.OpenFile(fileName);

            return (fs, GetModLangFilesFromStream(fs, type, fileType));
        }

        public static IEnumerable<ZipArchiveEntry> GetModLangFilesFromStream(Stream fs, LangType type, LangFileType fileType)
        {
            var files = new ZipArchive(fs).Entries
                .Where(f => f.FullName.Contains("lang") && f.FullName.Contains("assets") &&
                            f.FullName.Split('/').All(n => n != "minecraft") &&
                            type == LangType.EN
                    ? (f.Name.Equals("en_us.lang", StringComparison.OrdinalIgnoreCase) ||
                       f.Name.Equals("en_us.json", StringComparison.OrdinalIgnoreCase))
                    : (f.Name.Equals("zh_cn.lang", StringComparison.OrdinalIgnoreCase) ||
                       f.Name.Equals("zh_cn.json", StringComparison.OrdinalIgnoreCase))).ToArray();
            if (files.Length == 2 && files.Any(f => f.Name.EndsWith(".json")) && files.Any(f => f.Name.EndsWith(".lang"))) // storage drawers
            {
                files = fileType switch
                {
                    LangFileType.Lang => new[] {files.First(f => f.Name.EndsWith(".lang"))},
                    LangFileType.Json => new[] {files.First(f => f.Name.EndsWith(".json"))},
                    _ => throw new ArgumentOutOfRangeException(nameof(fileType), fileType, null)
                };
            }
            return files;
        }

    }

    [ConfigurationPath("config/mappings.json")]
    public class ModIDMappingMetadata : Configuration<ModIDMappingMetadata>
    {
        public Dictionary<string, int> Mapping { get; set; } = new();
        public DateTime LastUpdate { get; set; }
        [JsonIgnore] public int LastID => Mapping.Values.Max();
    }

    class CurseForgeIDMappingManager
    {
        public static async Task Build()
        {
            var client = new ForgeClient();
            var config = ModIDMappingMetadata.Instance;
            for (int i = 0; i < 40; i++)
            {
                var addons = await client.Addons.RetriveAddons(Enumerable.Range(i * 20000 + 1, 20000).ToArray());
                AddMapping(addons);
                Console.WriteLine($"初始化 Mapping: {i + 1}/40");
            }
            config.LastUpdate = DateTime.Now;
            ModIDMappingMetadata.Save();
        }

        static SemaphoreSlim semaphore = new SemaphoreSlim(1);
        public static async Task UpdateIfRequired()
        {
            var client = new ForgeClient();
            var config = ModIDMappingMetadata.Instance;
            var last = config.LastID;

            if ((DateTime.Now - config.LastUpdate).TotalDays < 2) return;

            try
            {
                await semaphore.WaitAsync();
                if ((DateTime.Now - config.LastUpdate).TotalDays < 2) return;
                var addons = await client.Addons.RetriveAddons(Enumerable.Range(last, 1000).ToArray());
                AddMapping(addons);
                config.LastUpdate = DateTime.Now;
                ModIDMappingMetadata.Save();
            }
            catch (Exception e)
            {

                // 不管
                // 还是管一下吧
                Log.Error(e, "Update Mapping");
            }
            finally
            {
                semaphore.Release();
            }
        }

        static void AddMapping(Addon[] addons)
        {
            foreach (var addon in addons.Where(s => s.GameSlug == "minecraft" && s.Website.StartsWith("https://www.curseforge.com/minecraft/mc-mods/")))
                lock (ModIDMappingMetadata.Instance)
                {
                    ModIDMappingMetadata.Instance.Mapping[addon.Slug] = addon.Identifier;
                }
        }
    }
}
