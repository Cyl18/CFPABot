using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using System.Web;
using ForgedCurse;
using ForgedCurse.Json;
using GammaLibrary;
using GammaLibrary.Extensions;
using Serilog;

//todo 不设置width
//todo mod标beta
namespace CFPABot.Utils
{
    public class CurseManager
    {
        public static async Task<string> GetThumbnailText(Addon addon)
        {
            var url = addon.Attachments.FirstOrDefault(a => a.Default)?.ThumbnailUrl;
            if (url == null) return "✨";

            await using var stream = await new HttpClient().GetStreamAsync(url);
            var fileName = $"{url.Split("/").Last()}";
            await using var fs = File.OpenWrite($"wwwroot/{fileName}");
            await stream.CopyToAsync(fs);
            return $"<image src=\"https://cfpa.cyan.cafe/static/{fileName}\" width=\"28\"/>";
        }

        public static string GetDownloadsText(Addon addon, MCVersion[] versions)
        {
            var sb = new StringBuilder();
            try
            {
                sb.Append("<details> <summary>展开</summary>");
                var p = new HashSet<int>();
                foreach (var file in addon.Files.OrderByDescending(s => new Version(s.GameVersion)))
                {
                    if (p.Contains(file.FileId)) continue;
                    
                    p.Add(file.FileId);
                    if (versions.Any(v => file.GameVersion.StartsWith(v.ToVersionString())))
                    {
                        sb.Append($"[{(!file.FileName.Contains(file.GameVersion) ? file.GameVersion : "")}{(file.FileType switch { 2 => "🅱 ", 3 => "🅰 ", 1 => "" })}{file.FileName.Replace('[', '*').Replace(']', '*').Replace(".jar","")}]({GetDownloadUrl(file)})<br />");
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

        public static async Task<string> GetRepoText(Addon addon)
        {
            var s = JsonDocument.Parse(await Download.String($"https://addons-ecs.forgesvc.net/api/v2/addon/{addon.Identifier}/"));
            try
            {
                var url = s.RootElement.GetProperty("sourceUrl").GetString();
                return url == null ? "无" : $"[链接]({url})";
            }
            catch (Exception e)
            {
                return "无";
            }
        }

        static string GetDownloadUrl(GameVersionLatestRelease release)
        {
            var s = release.FileId.ToString();
            return
                $"https://edge.forgecdn.net/files/{s.Substring(0, 4)}/{s.Substring(4, 3).ToInt()}/{(release.FileName.Replace(" ", "%20"))}";
        }

        public static int MapModIDToProjectID(string modid)
        {
            try
            {
                CurseForgeIDMappingManager.UpdateIfRequired();
                lock (ModIDMappingMetadata.Instance)
                {
                    return ModIDMappingMetadata.Instance.Mapping[modid];
                }
            }
            catch (Exception e)
            {
                Log.Error(e, "MapModIDToProjectID");
                throw new CheckException($"⚠ 无法找到 {modid} 的 ModID 到 ProjectID 的映射. 请检查文件路径是否正确.");
            }
        }

        public static Task<Addon> GetAddon(string modid)
        {
            return new ForgeClient().Addons.RetriveAddon(MapModIDToProjectID(modid));
        }

        public static async Task<string> GetModID(Addon addon, MCVersion? version)
        {
            if (version == null) return "未知";
            try
            {
                if (addon.Files.FirstOrDefault(f => f.GameVersion.StartsWith(version.Value.ToVersionString())) is {} file)
                {
                    var fileName = await Download.DownloadFile(GetDownloadUrl(file));
                    await using var fs = File.OpenRead(fileName);

                    var modid = new ZipArchive(fs).Entries
                        .Where(a => a.FullName.StartsWith("assets"))
                        .Select(a => a.FullName.Split("/")[1]).Distinct().Where(n => !n.IsNullOrWhiteSpace())
                        .Where(id => id != "minecraft")
                        .Connect(" \\| ", "*", "*");
                    return modid;
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
                if (addon.Files.FirstOrDefault(f => f.GameVersion.StartsWith(version.Value.ToVersionString())) is { } file)
                {
                    var fileName = await Download.DownloadFile(GetDownloadUrl(file));
                    await using var fs = File.OpenRead(fileName);

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

        public static async Task<(string[] files, string downloadFileName)> GetModEnFile(Addon addon, MCVersion? version)
        {
            if (version == null) return (null, null);
            try
            {
                if (addon.Files.OrderByDescending(f => f.FileId).FirstOrDefault(f => f.GameVersion.StartsWith(version.Value.ToVersionString())) is { } file)
                {
                    var fileName = await Download.DownloadFile(GetDownloadUrl(file));
                    await using var fs = File.OpenRead(fileName);

                    var files = new ZipArchive(fs).Entries
                        .Where(f => f.FullName.Contains("lang") && f.FullName.Contains("assets") &&
                                             f.FullName.Split('/').All(n => n != "minecraft") &&
                                             (f.Name.Equals("en_us.lang", StringComparison.OrdinalIgnoreCase) ||
                                              f.Name.Equals("en_us.json", StringComparison.OrdinalIgnoreCase)));

                    return (files.Select(f => f.Open().ReadToEnd()).ToArray(), file.FileName);
                }
            }
            catch (Exception e)
            {
                Log.Error(e, "GetModID 出错");
                return (null, null);
            }

            return (null, null);
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
                var addons = await client.Addons.RetriveAddons(Enumerable.Range(last, 1000).ToArray());
                AddMapping(addons);
                config.LastUpdate = DateTime.Now;
                ModIDMappingMetadata.Save();
            }
            catch (Exception e)
            {

                // 不管
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
