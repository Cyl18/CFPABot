using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using CFPABot.DiffEngine;

namespace CFPABot.Utils
{
    public enum MCVersion
    {
        v1122,
        v116,
        v118,
        v116fabric,
        v118fabric,
        v119,
        v120,
        v120fabric, v121, v121fabric, v122, v122fabric, v123, v123fabric, v124, v124fabric, v125, v125fabric, v126, v126fabric, v127, v127fabric, v128, v128fabric, v129, v129fabric, v130, v130fabric, v131, v131fabric, v132, v132fabric, v133, v133fabric, v134, v134fabric, v135, v135fabric, v136, v136fabric, v137, v137fabric, v138, v138fabric, v139, v139fabric, v140,

    }

    public static class MCVersionExtensions
    {
        public static string ToVersionString(this MCVersion version)
        {
            return version switch
            {
                MCVersion.v1122 => "1.12.2",
                MCVersion.v116 => "1.16",
                MCVersion.v118 => "1.18",
                MCVersion.v116fabric => "1.16-fabric",
                MCVersion.v118fabric => "1.18-fabric",
                MCVersion.v119 => "1.19",
                MCVersion.v120 => "1.20",
                MCVersion.v120fabric => "1.20-fabric", MCVersion.v121 => "1.21", MCVersion.v121fabric => "1.21-fabric", MCVersion.v122 => "1.22", MCVersion.v122fabric => "1.22-fabric", MCVersion.v123 => "1.23", MCVersion.v123fabric => "1.23-fabric", MCVersion.v124 => "1.24", MCVersion.v124fabric => "1.24-fabric", MCVersion.v125 => "1.25", MCVersion.v125fabric => "1.25-fabric", MCVersion.v126 => "1.26", MCVersion.v126fabric => "1.26-fabric", MCVersion.v127 => "1.27", MCVersion.v127fabric => "1.27-fabric", MCVersion.v128 => "1.28", MCVersion.v128fabric => "1.28-fabric", MCVersion.v129 => "1.29", MCVersion.v129fabric => "1.29-fabric", MCVersion.v130 => "1.30", MCVersion.v130fabric => "1.30-fabric", MCVersion.v131 => "1.31", MCVersion.v131fabric => "1.31-fabric", MCVersion.v132 => "1.32", MCVersion.v132fabric => "1.32-fabric", MCVersion.v133 => "1.33", MCVersion.v133fabric => "1.33-fabric", MCVersion.v134 => "1.34", MCVersion.v134fabric => "1.34-fabric", MCVersion.v135 => "1.35", MCVersion.v135fabric => "1.35-fabric", MCVersion.v136 => "1.36", MCVersion.v136fabric => "1.36-fabric", MCVersion.v137 => "1.37", MCVersion.v137fabric => "1.37-fabric", MCVersion.v138 => "1.38", MCVersion.v138fabric => "1.38-fabric", MCVersion.v139 => "1.39", MCVersion.v139fabric => "1.39-fabric", MCVersion.v140 => "1.40",
                _ => throw new ArgumentOutOfRangeException(nameof(version), version, null)
            };
        }

        public static string ToStandardVersionString(this MCVersion version)
        {
            return version switch
            {
                MCVersion.v1122 => "1.12.2",
                MCVersion.v116 => "1.16",
                MCVersion.v118 => "1.18",
                MCVersion.v116fabric => "1.16",
                MCVersion.v118fabric => "1.18",
                MCVersion.v119 => "1.19",
                MCVersion.v120 => "1.20",
                MCVersion.v120fabric => "1.20", MCVersion.v121 => "1.21", MCVersion.v121fabric => "1.21", MCVersion.v122 => "1.22", MCVersion.v122fabric => "1.22", MCVersion.v123 => "1.23", MCVersion.v123fabric => "1.23", MCVersion.v124 => "1.24", MCVersion.v124fabric => "1.24", MCVersion.v125 => "1.25", MCVersion.v125fabric => "1.25", MCVersion.v126 => "1.26", MCVersion.v126fabric => "1.26", MCVersion.v127 => "1.27", MCVersion.v127fabric => "1.27", MCVersion.v128 => "1.28", MCVersion.v128fabric => "1.28", MCVersion.v129 => "1.29", MCVersion.v129fabric => "1.29", MCVersion.v130 => "1.30", MCVersion.v130fabric => "1.30", MCVersion.v131 => "1.31", MCVersion.v131fabric => "1.31", MCVersion.v132 => "1.32", MCVersion.v132fabric => "1.32", MCVersion.v133 => "1.33", MCVersion.v133fabric => "1.33", MCVersion.v134 => "1.34", MCVersion.v134fabric => "1.34", MCVersion.v135 => "1.35", MCVersion.v135fabric => "1.35", MCVersion.v136 => "1.36", MCVersion.v136fabric => "1.36", MCVersion.v137 => "1.37", MCVersion.v137fabric => "1.37", MCVersion.v138 => "1.38", MCVersion.v138fabric => "1.38", MCVersion.v139 => "1.39", MCVersion.v139fabric => "1.39", MCVersion.v140 => "1.40",
                _ => throw new ArgumentOutOfRangeException(nameof(version), version, null)
            };
        }

        public static MCVersion ToMCVersion(this string version)
        {
            return version switch
            {
                "1.12.2" => MCVersion.v1122,
                "1.16" => MCVersion.v116,
                "1.18" => MCVersion.v118,
                "1.16-fabric" => MCVersion.v116fabric,
                "1.18-fabric" => MCVersion.v118fabric,
                "1.19" => MCVersion.v119,
                "1.20-fabric" => MCVersion.v120fabric,
                "1.20" => MCVersion.v120, "1.21" => MCVersion.v121, "1.21-fabric" => MCVersion.v121fabric, "1.22" => MCVersion.v122, "1.22-fabric" => MCVersion.v122fabric, "1.23" => MCVersion.v123, "1.23-fabric" => MCVersion.v123fabric, "1.24" => MCVersion.v124, "1.24-fabric" => MCVersion.v124fabric, "1.25" => MCVersion.v125, "1.25-fabric" => MCVersion.v125fabric, "1.26" => MCVersion.v126, "1.26-fabric" => MCVersion.v126fabric, "1.27" => MCVersion.v127, "1.27-fabric" => MCVersion.v127fabric, "1.28" => MCVersion.v128, "1.28-fabric" => MCVersion.v128fabric, "1.29" => MCVersion.v129, "1.29-fabric" => MCVersion.v129fabric, "1.30" => MCVersion.v130, "1.30-fabric" => MCVersion.v130fabric, "1.31" => MCVersion.v131, "1.31-fabric" => MCVersion.v131fabric, "1.32" => MCVersion.v132, "1.32-fabric" => MCVersion.v132fabric, "1.33" => MCVersion.v133, "1.33-fabric" => MCVersion.v133fabric, "1.34" => MCVersion.v134, "1.34-fabric" => MCVersion.v134fabric, "1.35" => MCVersion.v135, "1.35-fabric" => MCVersion.v135fabric, "1.36" => MCVersion.v136, "1.36-fabric" => MCVersion.v136fabric, "1.37" => MCVersion.v137, "1.37-fabric" => MCVersion.v137fabric, "1.38" => MCVersion.v138, "1.38-fabric" => MCVersion.v138fabric, "1.39" => MCVersion.v139, "1.39-fabric" => MCVersion.v139fabric, "1.40" => MCVersion.v140, 
                _ => throw new ArgumentOutOfRangeException(nameof(version), version, null)
            };
        }
        public static MCVersion ToMCStandardVersion(this string version)
        {
            return version switch
            {
                "1.12.2" => MCVersion.v1122,
                "1.16" => MCVersion.v116,
                "1.18" => MCVersion.v118,
                "1.16-fabric" => MCVersion.v116,
                "1.18-fabric" => MCVersion.v118,
                "1.19" => MCVersion.v119,
                "1.20-fabric" => MCVersion.v120,
                "1.20" => MCVersion.v120, "1.21" => MCVersion.v121, "1.21-fabric" => MCVersion.v121, "1.22" => MCVersion.v122, "1.22-fabric" => MCVersion.v122, "1.23" => MCVersion.v123, "1.23-fabric" => MCVersion.v123, "1.24" => MCVersion.v124, "1.24-fabric" => MCVersion.v124, "1.25" => MCVersion.v125, "1.25-fabric" => MCVersion.v125, "1.26" => MCVersion.v126, "1.26-fabric" => MCVersion.v126, "1.27" => MCVersion.v127, "1.27-fabric" => MCVersion.v127, "1.28" => MCVersion.v128, "1.28-fabric" => MCVersion.v128, "1.29" => MCVersion.v129, "1.29-fabric" => MCVersion.v129, "1.30" => MCVersion.v130, "1.30-fabric" => MCVersion.v130, "1.31" => MCVersion.v131, "1.31-fabric" => MCVersion.v131, "1.32" => MCVersion.v132, "1.32-fabric" => MCVersion.v132, "1.33" => MCVersion.v133, "1.33-fabric" => MCVersion.v133, "1.34" => MCVersion.v134, "1.34-fabric" => MCVersion.v134, "1.35" => MCVersion.v135, "1.35-fabric" => MCVersion.v135, "1.36" => MCVersion.v136, "1.36-fabric" => MCVersion.v136, "1.37" => MCVersion.v137, "1.37-fabric" => MCVersion.v137, "1.38" => MCVersion.v138, "1.38-fabric" => MCVersion.v138, "1.39" => MCVersion.v139, "1.39-fabric" => MCVersion.v139, "1.40" => MCVersion.v140,
                _ => throw new ArgumentOutOfRangeException(nameof(version), version, null)
            };
        }

        public static string ToCNLangFile(this MCVersion version)
        {
            return version switch
            {
                MCVersion.v1122 => "zh_cn.lang",
                _ => "zh_cn.json",
            };
        }

        public static string ToENLangFile(this MCVersion version)
        {
            return version switch
            {
                MCVersion.v1122 => "en_us.lang",
                _ => "en_us.json",
                };
        }
    }
}
