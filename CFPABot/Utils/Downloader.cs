using System;
using System.Collections.Generic;
using System.Collections.Specialized;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.WebSockets;
using System.Numerics;
using System.Threading;
using System.Threading.Tasks;
using GammaLibrary.Extensions;
using Serilog;

namespace CFPABot.Utils
{
    public class Download
    {
        public static HttpClient hc;
        public static HttpClient chc;

        static Download()
        {
            hc = new();
            chc = new();
            hc.DefaultRequestHeaders.Add("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36");
        }

        public static async Task<T> GitHubAPIJson<T>(string url)
        {
            var jsonhc = new HttpClient();
            jsonhc.DefaultRequestHeaders.Add("User-Agent", "cfpa-bot");
            jsonhc.DefaultRequestHeaders.Add("Authorization", $"bearer {GitHub.GetToken()}");
            return (await jsonhc.GetStringAsync(url)).JsonDeserialize<T>();
        }

        public static async Task<string> String(string url, bool withToken = false)
        {
            // xswl
            try
            {
                Log.Debug($"网络请求：{url}");
                if (!withToken)
                {
                    return await hc.GetStringAsync(url);
                }
                else
                {
                    var hc1 = new HttpClient();
                    hc1.DefaultRequestHeaders.Add("User-Agent", "cfpa-bot");
                    hc1.DefaultRequestHeaders.Add("Authorization", $"bearer {GitHub.GetToken()}");
                    return (await hc1.GetStringAsync(url));
                }
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

        static Dictionary<string, SuperUniversalExtremeAwesomeGodlikeSmartLock> locks = new();
        static async ValueTask<SuperUniversalExtremeAwesomeGodlikeSmartLock> AcquireLock(string lockName)
        {
            Log.Debug($"正在获取锁 {lockName}...");
            SuperUniversalExtremeAwesomeGodlikeSmartLock l;
            lock (locks)
            {
                if (!locks.ContainsKey(lockName)) locks[lockName] = new SuperUniversalExtremeAwesomeGodlikeSmartLock();
                l = locks[lockName];
            }
            await l.WaitAsync();
            return l;
        }
        public static async Task<string> DownloadFile(string url)
        {
            Log.Debug($"文件下载：{url}");
            Directory.CreateDirectory("temp");
            var fileName = $"{url.Split("/").Last()}";

            using var l = await AcquireLock($"download {fileName}");

            if (File.Exists($"temp/{fileName}"))
            {
                return $"temp/{fileName}";
            }
            await using var fs = File.OpenWrite($"temp/{fileName}");
            await using var stream = await hc.GetStreamAsync(url);
            await stream.CopyToAsync(fs);
            return $"temp/{fileName}";
        }

        public static async Task<string> CurseForgeString(string url)
        {
            // 好像反正 CurseForge API 给了 UserAgent 就要 403
            Log.Debug($"网络请求：{url}");
            return await chc.GetStringAsync(url);
        }
    }
}
