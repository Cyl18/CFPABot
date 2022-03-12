using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;

namespace CFPABot.Utils
{
    public enum MCVersion
    {
        v1122,
        v116,
        v118
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
                _ => throw new ArgumentOutOfRangeException(nameof(version), version, null)
            };
        }
    }
}
