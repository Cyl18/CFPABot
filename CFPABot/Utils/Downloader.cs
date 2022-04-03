using System;
using System.Collections.Generic;
using System.Collections.Specialized;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Net.WebSockets;
using System.Numerics;
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
        public static async Task<string> String(string url)
        {
            // xswl
            try
            {
                return await hc.GetStringAsync(url);
            }
            catch (Exception)
            {
                try
                {
                    await Task.Delay(500);
                    return await hc.GetStringAsync(url);
                }
                catch (Exception)
                {
                    await Task.Delay(500);
                    return await hc.GetStringAsync(url);
                }
            }
        }

        public static async Task<string> DownloadFile(string url)
        {
            Directory.CreateDirectory("temp");
            var fileName = $"{url.Split("/").Last()}";
            if (File.Exists($"temp/{fileName}"))
            {
                return $"temp/{fileName}";
            }
            await using var fs = File.OpenWrite($"temp/{fileName}");
            await using var stream = await new HttpClient().GetStreamAsync(url);
            await stream.CopyToAsync(fs);
            return $"temp/{fileName}";
        }
    }
}
