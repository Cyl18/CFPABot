using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using CFPABot.Command;
using CFPABot.Controllers;
using CFPABot.ProjectHex;
using CFPABot.Utils;
using GammaLibrary.Extensions;
using Octokit;
using Serilog;
using Serilog.Events;

namespace CFPABot
{
    public class Program
    {
        public static async Task Main(string[] args)
        {
            await TermManager.Init();
            TaskScheduler.UnobservedTaskException += (sender, eventArgs) =>
            {
                Log.Error(eventArgs.Exception, "UnobservedTaskException");
            };
            var cts = new CancellationTokenSource();
            Console.CancelKeyPress += (sender, eventArgs) =>
            {
                Wait();
                cts.Cancel();
            };
            AppDomain.CurrentDomain.ProcessExit += (sender, eventArgs) =>
            {
                Wait();
                cts.Cancel();
            };

            try
            {
                if (Directory.Exists("caches"))
                {
                    Directory.Delete("caches", true);
                }
            }
            catch (Exception e)
            {
                Console.WriteLine(e);
            }
            //GitHub.Init();
            Directory.CreateDirectory("config");
            Directory.CreateDirectory("wwwroot");
            Directory.CreateDirectory("config/pr_context");
            Directory.CreateDirectory("logs");
            Directory.CreateDirectory("config/repo_analyze_results");
            Directory.CreateDirectory("caches/");
            Directory.CreateDirectory("caches/repos/");
            Directory.CreateDirectory("project-hex");

            _ = Task.Run(async () =>
            {
                while (true)
                {
                    await RunProjectHex();

                    await Task.Delay(TimeSpan.FromMinutes(5));
                }
            }); 
            
            _ = Task.Run(async () =>
            {
                while (true)
                {
                    try
                    {
                        await CurseForgeIDMappingManager.Update();
                    }
                    catch (Exception e)
                    {
                        Console.WriteLine($"Mapping Error: {e}");
                    }

                    await Task.Delay(TimeSpan.FromMinutes(60));
                }
            });
            
            Log.Logger = new LoggerConfiguration()
                .MinimumLevel.Debug()
                .WriteTo.Console()
                .WriteTo.File("logs/myapp.txt", rollingInterval: RollingInterval.Day, restrictedToMinimumLevel: LogEventLevel.Information)
                //.WriteTo.File("logs/myapp-debug.txt", rollingInterval: RollingInterval.Day)
                .CreateLogger();
            await Init();
            try
            {
                await CreateHostBuilder(args).Build().RunAsync(cts.Token);
            }
            catch (Exception e)
            {
                Console.WriteLine(e);
            }
        }

        static SemaphoreSlim projectHexLocker = new(1);
        public static async Task RunProjectHex(bool force = false)
        {
            if (!await projectHexLocker.WaitAsync(1000))
            {
                return;
            }

            try
            {
                if (!Directory.GetFiles("project-hex").Any() ||
                    (DateTime.Now - ProjectHexConfig.Instance.LastTime).TotalDays > 0.25 || force)
                {
                    try
                    {
                        await new ProjectHexRunner().Run();
                        ProjectHexConfig.Instance.LastTime = DateTime.Now;
                        ProjectHexConfig.Instance.DownloadsSinceLastPack = 0;
                        ProjectHexConfig.Save();
                    }
                    catch (Exception e)
                    {
                        Log.Error(e, "project-hex");
                    }
                }

                
            }
            finally
            {
                projectHexLocker.Release();
            }
        }

        internal static bool ShuttingDown { get; private set; }

        static void Wait()
        {
            ShuttingDown = true;
            SpinWait.SpinUntil(() => MyWebhookEventProcessor.commentBuilders.All(c => !c.Value.IsAnyLockAcquired()));
            SpinWait.SpinUntil(() => CommandProcessor.CurrentRuns == 0);
        }

        static async Task Init()
        {
            Log.Information("正在加载 mapping..");
            if (ModIDMappingMetadata.Instance.Mapping.Count == 0)
            {
                Log.Information("开始构建 mapping..");
                //await CurseForgeIDMappingManager.Build();
            }
            Log.Information("mapping 加载完成");
        }

        public static IHostBuilder CreateHostBuilder(string[] args) =>
            Host.CreateDefaultBuilder(args)
                .ConfigureWebHostDefaults(webBuilder =>
                {
                    webBuilder.UseStartup<Startup>();
                }).ConfigureWebHost(x => x.UseStaticWebAssets());
    }
}
