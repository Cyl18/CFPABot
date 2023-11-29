using System;
using System.Net;
using System.Net.Http;
using System.Threading.Tasks;
using CFPABot.Exceptions;
using CFPABot.Utils;
using Serilog;

namespace CFPABot.DiffEngine
{
    public class ModVersion : IComparable<ModVersion>
    {
        public int CompareTo(ModVersion other)
        {
            if (ReferenceEquals(this, other)) return 0;
            if (ReferenceEquals(null, other)) return 1;
            var minecraftVersionComparison = MinecraftVersion.CompareTo(other.MinecraftVersion);
            if (minecraftVersionComparison != 0) return minecraftVersionComparison;
            return ModLoader.CompareTo(other.ModLoader);
        }

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
                    "1.19" or "1.19-fabric" => MinecraftVersion.v1_19,
                    "1.20" or "1.20-fabric" => MinecraftVersion.v1_20, "1.21" or "1.21-fabric" => MinecraftVersion.v1_21, "1.22" or "1.22-fabric" => MinecraftVersion.v1_22, "1.23" or "1.23-fabric" => MinecraftVersion.v1_23, "1.24" or "1.24-fabric" => MinecraftVersion.v1_24, "1.25" or "1.25-fabric" => MinecraftVersion.v1_25, "1.26" or "1.26-fabric" => MinecraftVersion.v1_26, "1.27" or "1.27-fabric" => MinecraftVersion.v1_27, "1.28" or "1.28-fabric" => MinecraftVersion.v1_28, "1.29" or "1.29-fabric" => MinecraftVersion.v1_29, "1.30" or "1.30-fabric" => MinecraftVersion.v1_30, "1.31" or "1.31-fabric" => MinecraftVersion.v1_31, "1.32" or "1.32-fabric" => MinecraftVersion.v1_32, "1.33" or "1.33-fabric" => MinecraftVersion.v1_33, "1.34" or "1.34-fabric" => MinecraftVersion.v1_34, "1.35" or "1.35-fabric" => MinecraftVersion.v1_35, "1.36" or "1.36-fabric" => MinecraftVersion.v1_36, "1.37" or "1.37-fabric" => MinecraftVersion.v1_37, "1.38" or "1.38-fabric" => MinecraftVersion.v1_38, "1.39" or "1.39-fabric" => MinecraftVersion.v1_39, "1.40" or "1.40-fabric" => MinecraftVersion.v1_40,
                    _ => throw new ArgumentOutOfRangeException()
                },
                ModLoader = gameVersionDirectory switch
                {
                    "1.12.2" or "1.16" or "1.18" or "1.19" or "1.20" or "1.21" or "1.22" or "1.23" or "1.24" or "1.25" or "1.26" or "1.27" or "1.28" or "1.29" or "1.30" or "1.31" or "1.32" or "1.33" or "1.34" or "1.35" or "1.36" or "1.37" or "1.38" or "1.39" or "1.40" => ModLoader.Forge,
                    "1.16-fabric" or "1.18-fabric" or "1.20-fabric" or "1.21-fabric" or "1.22-fabric" or "1.23-fabric" or "1.24-fabric" or "1.25-fabric" or "1.26-fabric" or "1.27-fabric" or "1.28-fabric" or "1.29-fabric" or "1.30-fabric" or "1.31-fabric" or "1.32-fabric" or "1.33-fabric" or "1.34-fabric" or "1.35-fabric" or "1.36-fabric" or "1.37-fabric" or "1.38-fabric" or "1.39-fabric" or "1.40-fabric" => ModLoader.Fabric,
                    _ => throw new ArgumentOutOfRangeException()
                }
            };

            return modVersion;
        }

        protected bool Equals(ModVersion other)
        {
            return MinecraftVersion == other.MinecraftVersion && ModLoader == other.ModLoader;
        }

        public override bool Equals(object obj)
        {
            if (ReferenceEquals(null, obj)) return false;
            if (ReferenceEquals(this, obj)) return true;
            if (obj.GetType() != this.GetType()) return false;
            return Equals((ModVersion) obj);
        }

        public override int GetHashCode()
        {
            unchecked
            {
                return ((int) MinecraftVersion * 397) ^ (int) ModLoader;
            }
        }

        public static bool operator ==(ModVersion left, ModVersion right)
        {
            return Equals(left, right);
        }

        public static bool operator !=(ModVersion left, ModVersion right)
        {
            return !Equals(left, right);
        }

        public override string ToString()
        {
            return ModPath.GetVersionDirectory(MinecraftVersion, ModLoader);
        }
        
        public string ToVersionDirectory()
        {
            return ModPath.GetVersionDirectory(MinecraftVersion, ModLoader);
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
        public ModVersion ModVersion { get; set; }

        public ModPath(string path)
        {
            var s = path.Split('/');
            GameVersionDirectoryName = s[1];
            CurseForgeSlug = s[3];
            ModDomain = s[4];
            var modVersion = ModVersion.FromGameVersionDirectory(GameVersionDirectoryName);
            ModVersion = modVersion;
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
                        MinecraftVersion.v1_19 => "1.19",
                        MinecraftVersion.v1_20 => "1.20", MinecraftVersion.v1_21 => "1.21", MinecraftVersion.v1_22 => "1.22", MinecraftVersion.v1_23 => "1.23", MinecraftVersion.v1_24 => "1.24", MinecraftVersion.v1_25 => "1.25", MinecraftVersion.v1_26 => "1.26", MinecraftVersion.v1_27 => "1.27", MinecraftVersion.v1_28 => "1.28", MinecraftVersion.v1_29 => "1.29", MinecraftVersion.v1_30 => "1.30", MinecraftVersion.v1_31 => "1.31", MinecraftVersion.v1_32 => "1.32", MinecraftVersion.v1_33 => "1.33", MinecraftVersion.v1_34 => "1.34", MinecraftVersion.v1_35 => "1.35", MinecraftVersion.v1_36 => "1.36", MinecraftVersion.v1_37 => "1.37", MinecraftVersion.v1_38 => "1.38", MinecraftVersion.v1_39 => "1.39", MinecraftVersion.v1_40 => "1.40",
                        _ => throw new ArgumentOutOfRangeException(nameof(minecraftVersion), minecraftVersion, null)
                    };
                case ModLoader.Fabric:
                    return minecraftVersion switch
                    {
                        MinecraftVersion.v1_16 => "1.16-fabric",
                        MinecraftVersion.v1_18 => "1.18-fabric",
                        MinecraftVersion.v1_20 => "1.20-fabric", MinecraftVersion.v1_21 => "1.21-fabric", MinecraftVersion.v1_22 => "1.22-fabric", MinecraftVersion.v1_23 => "1.23-fabric", MinecraftVersion.v1_24 => "1.24-fabric", MinecraftVersion.v1_25 => "1.25-fabric", MinecraftVersion.v1_26 => "1.26-fabric", MinecraftVersion.v1_27 => "1.27-fabric", MinecraftVersion.v1_28 => "1.28-fabric", MinecraftVersion.v1_29 => "1.29-fabric", MinecraftVersion.v1_30 => "1.30-fabric", MinecraftVersion.v1_31 => "1.31-fabric", MinecraftVersion.v1_32 => "1.32-fabric", MinecraftVersion.v1_33 => "1.33-fabric", MinecraftVersion.v1_34 => "1.34-fabric", MinecraftVersion.v1_35 => "1.35-fabric", MinecraftVersion.v1_36 => "1.36-fabric", MinecraftVersion.v1_37 => "1.37-fabric", MinecraftVersion.v1_38 => "1.38-fabric", MinecraftVersion.v1_39 => "1.39-fabric", MinecraftVersion.v1_40 => "1.40-fabric",
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
            var l1split = lang1.Split("_");
            var lang2 = l1split[0] + "_" + l1split[1].ToUpper();
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
            if (await LinkExists(url1).ConfigureAwait(false))
            {
                return await Download.String(url1, true).ConfigureAwait(false);
            }
            else if (await LinkExists(url2).ConfigureAwait(false))
            {
                return await Download.String(url2, true).ConfigureAwait(false);
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
                var message = await hc.SendAsync(new HttpRequestMessage(HttpMethod.Head, link));
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
        v1_18,
        v1_19,
        v1_20,
        v1_21,
        v1_22, v1_23, v1_24, v1_25, v1_26, v1_27, v1_28, v1_29, v1_30, v1_31, v1_32, v1_33, v1_34, v1_35, v1_36, v1_37, v1_38, v1_39, v1_40, v1_41, v1_42, v1_43, v1_44, v1_45, v1_46, v1_47, v1_48, v1_49, v1_50, v1_51, v1_52, v1_53, v1_54, v1_55, v1_56, v1_57, v1_58, v1_59, v1_60, v1_61, v1_62, v1_63, v1_64, v1_65, v1_66, v1_67, v1_68, v1_69, v1_70, v1_71, v1_72, v1_73, v1_74, v1_75, v1_76, v1_77, v1_78, v1_79, v1_80, v1_81, v1_82, v1_83, v1_84, v1_85, v1_86, v1_87, v1_88, v1_89, v1_90, v1_91, v1_92, v1_93, v1_94, v1_95, v1_96, v1_97, v1_98, v1_99, v1_100, v1_101, v1_102, v1_103, v1_104, v1_105, v1_106, v1_107, v1_108, v1_109, v1_110, v1_111, v1_112, v1_113, v1_114, v1_115, v1_116, v1_117, v1_118, v1_119, v1_120, v1_121, v1_122,

    }
}
