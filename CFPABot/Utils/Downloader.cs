using System;
using System.Collections.Concurrent;
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
using CFPABot.Command;
using CFPABot.Controllers;
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
            if (url.Contains("+")) url = url.Replace("https://edge.forgecdn.net", "https://mediafilez.forgecdn.net");

            var fileName = $"{url.Split("/").Last()}";

            using var l = await AcquireLock($"download {fileName}");

            if (File.Exists($"temp/{fileName}"))
            {
                lastAccessTime[fileName] = DateTime.Now;
                return $"temp/{fileName}";
            }
            await using var fs = File.OpenWrite($"temp/{fileName}");
            await using var stream = await hc.GetStreamAsync(url);
            await stream.CopyToAsync(fs);
            Task.Run(async () =>
            {
                await Task.Delay(TimeSpan.FromDays(1));
                if (lastAccessTime.TryGetValue(fileName, out var time) && DateTime.Now - time < TimeSpan.FromDays(0.5)) return;
                
                var l = await AcquireLock($"download {fileName}");

                while (!SpinWait.SpinUntil(() =>
                           MyWebhookEventProcessor.commentBuilders.All(c => !c.Value.IsAnyLockAcquired()), 100) ||
                       !SpinWait.SpinUntil(() => CommandProcessor.CurrentRuns == 0, 100))
                {
                    l.Dispose();
                    await Task.Delay(1000);
                    l = await AcquireLock($"download {fileName}");
                }
                File.Delete($"temp/{fileName}");
                lastAccessTime.TryRemove(fileName, out _);
                l.Dispose();

            });
            return $"temp/{fileName}";
        }

        private static ConcurrentDictionary<string, DateTime> lastAccessTime = new();
        public static async Task<bool> LinkExists(string link)
        {
            try
            {
                var message = await hc.SendAsync(new HttpRequestMessage(HttpMethod.Head, link));
                message.EnsureSuccessStatusCode();
                return true;
            }
            catch (Exception)
            {
                return false;
            }
        }
        public static async Task<string> CurseForgeString(string url)
        {
            // 好像反正 CurseForge API 给了 UserAgent 就要 403
            Log.Debug($"网络请求：{url}");
            return await chc.GetStringAsync(url);
        }
    }
}
