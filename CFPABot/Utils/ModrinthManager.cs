using System.Collections.Generic;
using System.IO.Compression;
using System.IO;
using System;
using System.Linq;
using System.Threading.Tasks;
using GammaLibrary.Extensions;
using Modrinth;
using Modrinth.Models;
using Serilog;

namespace CFPABot.Utils
{
    public class ModrinthManager
    {
        public static ModrinthClient Instance = new ModrinthClient();

        public static Task<Project> GetMod(string slug)
        {
            
            return Instance.Project.GetAsync(slug);
        }

        public static async Task<string> GetModID(Project addon, MCVersion? version, bool enforcedLang = false,
    bool connect = true)
        {
            if (version == null) return "未知";
            try
            {
                var versions = await Instance.Version.GetProjectVersionListAsync(addon.Slug, new []{ version.ToString().Contains("fabric") ? "fabric": "forge"});
                if (versions.FirstOrDefault(f => f.GameVersions.Any(x=> x.StartsWith(version.Value.ToStandardVersionString()))) is { } file)
                {
                    var fileName = await Download.DownloadFile(file.Files.First().Url); // 我好累
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

        public static async Task<string[]> GetModIDForCheck(Project addon, MCVersion? version)
        {
            if (version == null) return null;
            try
            {
                var versions = await Instance.Version.GetProjectVersionListAsync(addon.Slug, new []{ version.ToString().Contains("fabric") ? "fabric": "forge"});
                if (versions.Where(x => x.GameVersions.Any(y => y.StartsWith(version.Value.ToStandardVersionString()))).FirstOrDefault() is {} file)
                {
                    var fileName = await Download.DownloadFile(file.Files.Any(x => x.FileName.ToLower().Contains("fabric") && version.ToString().Contains("fabric"))?file.Files.First(x => x.FileName.ToLower().Contains("fabric")).Url: file.Files.First().Url);
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

        public static async Task<(string[] files, string downloadFileName)> GetModEnFile(Project addon, MCVersion? version, LangType type)
        {
            if (version == null) return (null, null);
            try
            {
                var versions = await Instance.Version.GetProjectVersionListAsync(addon.Slug, new[] { version.ToString().Contains("fabric") ? "fabric" : "forge" });
                if (versions.Where(x => x.GameVersions.Any(y => y.StartsWith(version.Value.ToStandardVersionString()))).FirstOrDefault() is { } file)
                {
                    var d = file.Files.Any(x => x.FileName.ToLower().Contains("fabric") && version.ToString().Contains("fabric")) ? file.Files.First(x => x.FileName.ToLower().Contains("fabric")) : file.Files.First();
                    var downloadUrl = d.Url;
                    var (fs, files) = await GetModLangFiles(downloadUrl, type, version == MCVersion.v1122 ? LangFileType.Lang : LangFileType.Json);

                    await using (fs)
                    {
                        return (files.Select(f => f.Open().ReadToEnd()).ToArray(), d.FileName);
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
                    LangFileType.Lang => new[] { files.First(f => f.Name.EndsWith(".lang")) },
                    LangFileType.Json => new[] { files.First(f => f.Name.EndsWith(".json")) },
                    _ => throw new ArgumentOutOfRangeException(nameof(fileType), fileType, null)
                };
            }
            return files;
        }

    }
}
