using System;
using System.Net;
using System.Net.Http;
using System.Threading.Tasks;
using CFPABot.Exceptions;
using CFPABot.Utils;
using Serilog;

namespace CFPABot.DiffEngine
{
    public class ModVersion
    {
        public MinecraftVersion MinecraftVersion { get; set; }
        public ModLoader ModLoader { get; set; }

        public ModVersion(MinecraftVersion minecraftVersion, ModLoader modLoader)
        {
            MinecraftVersion = minecraftVersion;
            ModLoader = modLoader;
        }

        private ModVersion()
        {

        }

        public static ModVersion FromGameVersionDirectory(string gameVersionDirectory)
        {
            var modVersion = new ModVersion
            {
                MinecraftVersion = gameVersionDirectory switch
                {
                    "1.12.2" => MinecraftVersion.v1_12,
                    "1.16" or "1.16-fabric" => MinecraftVersion.v1_16,
                    "1.18" or "1.18-fabric" => MinecraftVersion.v1_18,
                    _ => throw new ArgumentOutOfRangeException()
                },
                ModLoader = gameVersionDirectory switch
                {
                    "1.12.2" or "1.16" or "1.18" => ModLoader.Forge,
                    "1.16-fabric" or "1.18-fabric" => ModLoader.Fabric,
                    _ => throw new ArgumentOutOfRangeException()
                }
            };

            return modVersion;
        }
    }

    public class ModPath
    {
        public ModLoader ModLoader { get; set; }
        public MinecraftVersion MinecraftVersion { get; set; }
        public string GameVersionDirectoryName { get; set; }
        public string CurseForgeSlug { get; set; }
        public string ModDomain { get; set; }
        public LangFileType LangFileType { get; set; }

        public ModPath(string path)
        {
            var s = path.Split('/');
            GameVersionDirectoryName = s[1];
            CurseForgeSlug = s[3];
            ModDomain = s[4];
            var modVersion = ModVersion.FromGameVersionDirectory(GameVersionDirectoryName);
            MinecraftVersion = modVersion.MinecraftVersion;
            ModLoader = modVersion.ModLoader;
            LangFileType = MinecraftVersion switch
            {
                MinecraftVersion.v1_12 => LangFileType.Lang,
                _ => LangFileType.Json
            };

        }

        public string ToPathString()
        {
            return $"projects/{GameVersionDirectoryName}/assets/{CurseForgeSlug}/{ModDomain}/";
        }

        public static string GetVersionDirectory(MinecraftVersion minecraftVersion, ModLoader modLoader)
        {
            switch (modLoader)
            {
                case ModLoader.Forge:
                    return minecraftVersion switch
                    {
                        MinecraftVersion.v1_12 => "1.12",
                        MinecraftVersion.v1_16 => "1.16",
                        MinecraftVersion.v1_18 => "1.18",
                        _ => throw new ArgumentOutOfRangeException(nameof(minecraftVersion), minecraftVersion, null)
                    };
                case ModLoader.Fabric:
                    return minecraftVersion switch
                    {
                        MinecraftVersion.v1_16 => "1.16-fabric",
                        MinecraftVersion.v1_18 => "1.18-fabric",
                        _ => throw new ArgumentOutOfRangeException(nameof(minecraftVersion), minecraftVersion, null)
                    };
            }

            throw new ArgumentOutOfRangeException();
        }

        protected bool Equals(ModPath other)
        {
            return GameVersionDirectoryName == other.GameVersionDirectoryName && CurseForgeSlug == other.CurseForgeSlug && ModDomain == other.ModDomain;
        }

        public override bool Equals(object obj)
        {
            if (ReferenceEquals(null, obj)) return false;
            if (ReferenceEquals(this, obj)) return true;
            if (obj.GetType() != this.GetType()) return false;
            return Equals((ModPath) obj);
        }

        public override int GetHashCode()
        {
            unchecked
            {
                var hashCode = (GameVersionDirectoryName != null ? GameVersionDirectoryName.GetHashCode() : 0);
                hashCode = (hashCode * 397) ^ (CurseForgeSlug != null ? CurseForgeSlug.GetHashCode() : 0);
                hashCode = (hashCode * 397) ^ (ModDomain != null ? ModDomain.GetHashCode() : 0);
                return hashCode;
            }
        }

        public static bool operator ==(ModPath left, ModPath right)
        {
            return Equals(left, right);
        }

        public static bool operator !=(ModPath left, ModPath right)
        {
            return !Equals(left, right);
        }

        public override string ToString()
        {
            return $"{CurseForgeSlug}/{GameVersionDirectoryName}";
        }
    }

    public class LangFilePath
    {
        public string RawPath { get; set; }
        public ModPath ModPath { get; set; }
        public LangType LangType { get; set; }
        public LangFileType LangFileType { get; set; }

        public LangFilePath(string path)
        {
            RawPath = path;
            var s = path.Split('/');
            // projects/{versionString}/assets/{curseForgeID}/{modID}/lang/{versionFile}

            ModPath = new ModPath(path);

            LangFileType = ModPath.MinecraftVersion switch
            {
                MinecraftVersion.v1_12 => LangFileType.Lang,
                _ => LangFileType.Json
            };

            LangType = LangFileType switch
            {
                LangFileType.Json => s[6] switch
                {
                    "zh_cn.json" or "zh_CN.json" => LangType.CN,
                    "en_us.json" or "en_US.json" => LangType.EN,
                    _ => throw new ArgumentOutOfRangeException()
                },
                LangFileType.Lang => s[6] switch
                {
                    "zh_cn.lang" or "zh_CN.lang" => LangType.CN,
                    "en_us.lang" or "en_US.lang" => LangType.EN,
                    _ => throw new ArgumentOutOfRangeException()
                },
                _ => throw new ArgumentOutOfRangeException()
            };
        }

        public LangFilePath(ModPath modPath, LangType type)
        {
            ModPath = modPath;
            LangType = type;
            LangFileType = ModPath.MinecraftVersion switch
            {
                MinecraftVersion.v1_12 => LangFileType.Lang,
                _ => LangFileType.Json
            };
        }

        public async Task<string> FetchFromCommit(string commitHash)
        {
            var path = ModPath.ToPathString();
            var lang1 = LangType switch
            {
                LangType.CN => "zh_cn",
                LangType.EN => "en_us",
                _ => throw new ArgumentOutOfRangeException()
            };
            var lang2 = LangType switch
            {
                LangType.CN => "zh_CN",
                LangType.EN => "en_US",
                _ => throw new ArgumentOutOfRangeException()
            };
            var langFileName1 = LangFileType switch
            {
                LangFileType.Json => $"{lang1}.json",
                LangFileType.Lang => $"{lang1}.lang",
                _ => throw new ArgumentOutOfRangeException()
            };
            var langFileName2 = LangFileType switch
            {
                LangFileType.Json => $"{lang2}.json",
                LangFileType.Lang => $"{lang2}.lang",
                _ => throw new ArgumentOutOfRangeException()
            };
            var url1 = $"https://raw.githubusercontent.com/CFPAOrg/Minecraft-Mod-Language-Package/{commitHash}/{path}lang/{langFileName1}";
            var url2 = $"https://raw.githubusercontent.com/CFPAOrg/Minecraft-Mod-Language-Package/{commitHash}/{path}lang/{langFileName2}";
            if (await LinkExists(url1))
            {
                return await Download.String(url1, true);
            }
            else if (await LinkExists(url2))
            {
                return await Download.String(url2, true);
            }
            else
            {
                return null;
            }
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
    }

    public enum ModLoader
    {
        Forge,
        Fabric
    }

    public enum MinecraftVersion
    {
        v1_12,
        v1_16,
        v1_18
    }
}
