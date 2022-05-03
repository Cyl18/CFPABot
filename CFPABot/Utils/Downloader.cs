using System;
using System.Collections.Generic;
using System.Collections.Specialized;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.WebSockets;
using System.Numerics;
using System.Threading.Tasks;
using Serilog;

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
            catch (HttpRequestException e1)
            {
                try
                {
                    if (e1.StatusCode == HttpStatusCode.TooManyRequests)
                    {
                        Log.Warning(e1, $"HTTP 429: {url}");
                        await Task.Delay(TimeSpan.FromSeconds(15));
                    }
                    await Task.Delay(500);
                    return await hc.GetStringAsync(url);
                }
                catch (HttpRequestException e2)
                {
                    if (e2.StatusCode == HttpStatusCode.TooManyRequests)
                    {
                        await Task.Delay(TimeSpan.FromSeconds(30));
                    }
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
