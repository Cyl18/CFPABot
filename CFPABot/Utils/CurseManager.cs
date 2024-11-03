using System;
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
using CFPABot.Exceptions;
using CFPABot.Resources;
using CurseForge.APIClient;
using CurseForge.APIClient.Models.Files;
using CurseForge.APIClient.Models.Mods;
using GammaLibrary;
using GammaLibrary.Extensions;
using Octokit;
using Serilog;
using ApiClient = CurseForge.APIClient.ApiClient;
using Exception = System.Exception;
using File = System.IO.File;

namespace CFPABot.Utils
{
    public static class CurseManager
    {
        public static async Task<string> GetThumbnailText(Mod addon)
        {
            try
            {
                var url = addon.Logo.ThumbnailUrl;
                if (url == null) return "✨";
                var fileName = $"{url.Split("/").Last()}";
                if (File.Exists($"wwwroot/{fileName}"))
                {
                    return $"<image src=\"https://cfpa.cyan.cafe/static/{fileName}\" width=\"32\"/>";
                }
                await using var stream = await new HttpClient().GetStreamAsync(url);
                await using var fs = File.OpenWrite($"wwwroot/{fileName}");
                await stream.CopyToAsync(fs);
                return $"<image src=\"https://cfpa.cyan.cafe/static/{fileName}\" width=\"32\"/>";
            }
            catch (Exception)
            {
                return "✨";
            }
        }

        public static string GetDownloadsText(Mod addon, MCVersion[] versions)
        {
            var sb = new StringBuilder();
            try
            {
                sb.Append("<details> <summary>最新模组文件</summary>");
                var p = new HashSet<int>();
                // https://github.com/CFPAOrg/Minecraft-Mod-Language-Package/pull/2538
                foreach (var file in GetAllModFiles(addon).Result.OrderByDescending(s => new Version(s.GameVersions.Where(x => !x.Contains('-')).First(v => v.Contains(".")/*sb curseforge*/))))
                {
                    if (p.Contains(file.Id)) continue;

                    p.Add(file.Id);
                    if (versions.Any(v => file.GetGameVersionString().StartsWith(v.ToStandardVersionString())))
                    {
                        sb.Append($"[**{file.GetGameVersionString()}**/{(file.ReleaseType switch { FileReleaseType.Beta => "🅱 ", FileReleaseType.Alpha => "🅰 ", FileReleaseType.Release => "", _ => throw new ArgumentOutOfRangeException()})}{file.FileName.Replace('[', '*').Replace(']', '*').Replace(".jar", "")}]({GetDownloadUrl(file)})<br />");
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
        

        public static async Task<string> GetModRepoLinkText(Mod addon, ModInfo[] infos)
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

        public static string GetRepoText(Mod addon)
        {
            try
            {
                var url = addon.Links.SourceUrl;
                return url.IsNullOrEmpty() ? ":mag:无源代码" : $"[:mag: 源代码]({url})&nbsp;&nbsp;";
            }
            catch (Exception)
            {
                return ":mag:无源代码";
            }
        }
        

        public static string GetDownloadUrl(CurseForge.APIClient.Models.Files.File release)
        {
            // https://github.com/huanghongxun/HMCL/blob/javafx/HMCLCore/src/main/java/org/jackhuang/hmcl/mod/curse/CurseManifestFile.java#L87
            var fileID = release.Id;
            return release.DownloadUrl ?? $"https://edge.forgecdn.net/files/{fileID / 1000}/{fileID%1000}/{HttpUtility.UrlEncode(release.FileName).Replace(" ", "%20")}";
        }

        public static int MapModIDToProjectID(string modid)
        {
            try
            {
                //_ = CurseForgeIDMappingManager.UpdateIfRequired();
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

        
        static Dictionary<int, WeakReference<Mod>> ModCache = new ();
        static Dictionary<int, DateTime> ModCacheWriteTime = new ();
        public static  Task<Mod> GetAddon(string modSlug)
        {
            return GetAddon((int) MapModIDToProjectID(modSlug));
        }
        public static async Task<Mod> GetAddon(int modCurseForgeID)
        {
            // https://github.com/CurseForgeCommunity/.NET-APIClient/issues/1
            var cfClient = GetCfClient();
            Log.Debug($"获取 Addon: {modCurseForgeID}");
            // 恨不得我的邮箱被塞爆
            lock (ModCache)
            {
                if (ModCache.TryGetValue(modCurseForgeID, out var r) && r.TryGetTarget(out var m) && (DateTime.Now - ModCacheWriteTime[modCurseForgeID]) < TimeSpan.FromMinutes(5))
                {
                    return m;
                }
            }
            
            var res = (await cfClient.GetModAsync(modCurseForgeID)).Data;

            lock (ModCache)
            {
                ModCache[modCurseForgeID] = new WeakReference<Mod>(res);
                ModCacheWriteTime[modCurseForgeID] = DateTime.Now;
            }
            return res;
        }

        public static CurseForge.APIClient.ApiClient GetCfClient()
        {
            return new CurseForge.APIClient.ApiClient(Constants.CurseForgeApiKey,
                ("Y3lsMThhQGdt" + "YWlsLmNvbQ==").ToBase64SourceBytes().ToUTF8String());
        }

        public static async Task<string> GetModID(Mod addon, MCVersion? version, bool enforcedLang = false,
            bool connect = true)
        {
            if (version == null) return "未知";
            try
            {
                if (addon.LatestFiles.FirstOrDefault(f => f.GetGameVersionString().StartsWith(version.Value.ToStandardVersionString())) is { } file)
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
                else
                {
                    var allModFiles = await GetAllModFiles(addon);
                    if (allModFiles.FirstOrDefault(f =>
                            f.GetGameVersionString().StartsWith(version.Value.ToStandardVersionString())) is { } file1)
                    {
                        var fileName = await Download.DownloadFile(GetDownloadUrl(file1));
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
            }
            catch (Exception e)
            {
                Log.Error(e, "GetModID 出错");
                return $"未知";
            }
            return "未知";
        }

        static Dictionary<int, WeakReference<List<CurseForge.APIClient.Models.Files.File>>> ModFilesCache = new();


        
        
        public class CurseModFilesMetadata
        {
            public List<CurseForge.APIClient.Models.Files.File> Files { get; set; }
            public DateTime UpdateTime { get; set; }
            public int ModID { get; set; }
            const string CachePath = "config/curse_files_cache";

            [JsonIgnore]
            public bool Invalid => (DateTime.UtcNow - UpdateTime) > TimeSpan.FromDays(1);
            static readonly object locker = new();

            public static CurseModFilesMetadata TryGet(int modid)
            {
                var filePath = Path.Combine(CachePath, $"{modid}.json");
                lock (locker) 
                    if (File.Exists(filePath))
                    {
                        try
                        {
                            using var fs = File.OpenRead(filePath);
                            var d = JsonSerializer.Deserialize<CurseModFilesMetadata>(fs);
                            if (!d.Invalid) return d;
                            
                        }
                        catch (Exception)
                        {
                            try
                            {
                                File.Delete(filePath);
                            }
                            catch (Exception)
                            {
                            }
                        }
                    }

                return null;
            }

            public static void Save(int modid, List<CurseForge.APIClient.Models.Files.File> files)
            {
                var filePath = Path.Combine(CachePath, $"{modid}.json");

                lock (locker)
                {
                    if (File.Exists(filePath)) File.Delete(filePath);
                    var d = new CurseModFilesMetadata() {ModID = modid, Files = files, UpdateTime = DateTime.UtcNow};
                    File.WriteAllText(filePath, JsonSerializer.Serialize(d));
                }
            }
        }
        
        public static async Task<List<CurseForge.APIClient.Models.Files.File>> GetAllModFiles(Mod mod)
        {
            var modId = mod.Id;

            lock (ModFilesCache)
            {
                if (ModFilesCache.TryGetValue(modId, out var r) && r.TryGetTarget(out var m))
                {
                    return m;
                }
            }
            
            if (CurseModFilesMetadata.TryGet(modId) is {} d)
            {
                return d.Files;
            }

            var cfClient = GetCfClient();
            int page = 0;
            var result = new List<CurseForge.APIClient.Models.Files.File>();

            do
            {
                var files = await cfClient.GetModFilesAsync(modId, pageSize: 10000);

                if (files.Data.Count == 0)
                {
                    break;
                }
                result.AddRange(files.Data);
            } while (false);

            lock (ModFilesCache)
            {
                ModFilesCache[modId] = new WeakReference<List<CurseForge.APIClient.Models.Files.File>>(result);
                CurseModFilesMetadata.Save(modId, result);
            }
            return result;
        }

        public static async Task<string[]> GetModIDForCheck(Mod addon, MCVersion? version)
        {
            if (version == null) return null;
            try
            {
                if (addon.LatestFiles.OrderBy(x => version.Value.ToVersionString().Contains("fabric") ? !x.SortableGameVersions.Any(y => y.GameVersionName == "Fabric")
                        : x.SortableGameVersions.Any(y => y.GameVersionName == "Fabric")).FirstOrDefault(f => f.GetGameVersionString().StartsWith(version.Value.ToStandardVersionString())) is { } file)
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
                else
                {
                    var allModFiles = await GetAllModFiles(addon);
                    if (allModFiles.OrderBy(x => version.Value.ToVersionString().Contains("fabric") ? !x.SortableGameVersions.Any(y => y.GameVersionName == "Fabric")
                            : x.SortableGameVersions.Any(y => y.GameVersionName == "Fabric")).FirstOrDefault(f => f.GetGameVersionString().StartsWith(version.Value.ToStandardVersionString())) is { } file1)
                    {
                        var fileName = await Download.DownloadFile(GetDownloadUrl(file1));
                        await using var fs = FileUtils.OpenFile(fileName);

                        var modids = new ZipArchive(fs).Entries
                            .Where(a => a.FullName.StartsWith("assets"))
                            .Select(a => a.FullName.Split("/")[1]).Distinct().Where(n => !n.IsNullOrWhiteSpace())
                            .Where(id => id != "minecraft")
                            .ToArray();
                        return modids;
                    }
                }
            }
            catch (Exception e)
            {
                Log.Error(e, "GetModID 出错");
                return null;
            }

            return null;
        }

        public static async Task<(string[] files, string downloadFileName)> GetModEnFile(Mod addon, MCVersion? version, LangType type)
        {
            if (version == null) return (null, null);
            try
            {
                if (addon.LatestFiles.OrderByDescending(f => f.Id).ThenBy(x => version.Value.ToVersionString().Contains("fabric") ? !x.SortableGameVersions.Any(y => y.GameVersionName == "Fabric")
                        : x.SortableGameVersions.Any(y => y.GameVersionName == "Fabric")).FirstOrDefault(f => f.GetGameVersionString().StartsWith(version.Value.ToStandardVersionString())) is { } file)
                {
                    var downloadUrl = GetDownloadUrl(file);
                    var (fs, files) = await GetModLangFiles(downloadUrl, type, version == MCVersion.v1122 ? LangFileType.Lang : LangFileType.Json);

                    await using (fs)
                    {
                        return (files.Select(f => f.Open().ReadToEnd()).ToArray(), file.FileName);
                    }
                }
                else
                {
                    var allModFiles = await GetAllModFiles(addon);
                    if (allModFiles.OrderByDescending(f => f.Id).ThenBy(x => version.Value.ToVersionString().Contains("fabric") ? !x.SortableGameVersions.Any(y => y.GameVersionName == "Fabric")
                            : x.SortableGameVersions.Any(y => y.GameVersionName == "Fabric")).FirstOrDefault(f =>
                            f.GetGameVersionString().StartsWith(version.Value.ToStandardVersionString())) is { } file1)
                    {
                        var downloadUrl = GetDownloadUrl(file1);
                        var (fs, files) = await GetModLangFiles(downloadUrl, type, version == MCVersion.v1122 ? LangFileType.Lang : LangFileType.Json);

                        await using (fs)
                        {
                            return (files.Select(f => f.Open().ReadToEnd()).ToArray(), file1.FileName);
                        }
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

    static class CurseForgeClientExtensions
    {
        public static string GetGameVersionString(this CurseForge.APIClient.Models.Files.File f)
        {
            // bug 实际上有的模组文件会有多个版本
            return f.GameVersions.FirstOrDefault(v => v.Contains(".")) ?? "x"; 
        }
    }
    class CurseForgeIDMappingManager
    {
        public static async Task Update()
        {
            var addons = await CurseManager.GetCfClient().GetModsByIdListAsync(new GetModsByIdsListRequestBody() { ModIds = Enumerable.Range(ModIDMappingMetadata.Instance.LastID, 20000).Select(x => x).ToList() });
            List<Mod> addonsData = addons.Data;
            AddMapping(addonsData);
            ModIDMappingMetadata.Save();
        }

        static void AddMapping(List<Mod> addons)
        {
            foreach (var addon in addons.Where(s => s.GameId == 432 && s.Links.WebsiteUrl.StartsWith("https://www.curseforge.com/minecraft/mc-mods/")))
                lock (ModIDMappingMetadata.Instance)
                {
                    ModIDMappingMetadata.Instance.Mapping[addon.Slug] = (int)addon.Id;
                }
        }
        // public static async Task Build()
        // {
        //     var client = new ForgeClient();
        //     var config = ModIDMappingMetadata.Instance;
        //     for (int i = 0; i < 40; i++)
        //     {
        //         var addons = await client.Addons.RetriveAddons(Enumerable.Range(i * 20000 + 1, 20000).ToArray());
        //         AddMapping(addons);
        //         Console.WriteLine($"初始化 Mapping: {i + 1}/40");
        //     }
        //     config.LastUpdate = DateTime.Now;
        //     ModIDMappingMetadata.Save();
        // }
        //
        // static SemaphoreSlim semaphore = new SemaphoreSlim(1);
        // public static async Task UpdateIfRequired()
        // {
        //     var client = new ForgeClient();
        //     var config = ModIDMappingMetadata.Instance;
        //     var last = config.LastID;
        //
        //     if ((DateTime.Now - config.LastUpdate).TotalDays < 2) return;
        //
        //     try
        //     {
        //         await semaphore.WaitAsync();
        //         if ((DateTime.Now - config.LastUpdate).TotalDays < 2) return;
        //         var addons = await client.Addons.RetriveAddons(Enumerable.Range(last, 1000).ToArray());
        //         AddMapping(addons);
        //         config.LastUpdate = DateTime.Now;
        //         ModIDMappingMetadata.Save();
        //     }
        //     catch (Exception e)
        //     {
        //
        //         // 不管
        //         // 还是管一下吧
        //         Log.Error(e, "Update Mapping");
        //     }
        //     finally
        //     {
        //         semaphore.Release();
        //     }
        // }
        //
        // static void AddMapping(Addon[] addons)
        // {
        //     foreach (var addon in addons.Where(s => s.GameSlug == "minecraft" && s.Website.StartsWith("https://www.curseforge.com/minecraft/mc-mods/")))
        //         lock (ModIDMappingMetadata.Instance)
        //         {
        //             ModIDMappingMetadata.Instance.Mapping[addon.Slug] = addon.Identifier;
        //         }
        // }
    }
}
