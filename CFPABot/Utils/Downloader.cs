using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Threading.Tasks;

namespace CFPABot.Utils
{
    public class Download
    {
        public static HttpClient hc;

        static Download()
        {
            hc = new();
            hc.DefaultRequestHeaders.Add("User-Agent", "Cyl18-Bot");
        }
        public static Task<string> String(string url)
        {
            return hc.GetStringAsync(url);
        }
    }
}
