using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using CFPABot.Azusa;
using CFPABot.Azusa.Pages;
using CFPABot.Command;
using CFPABot.Controllers;
using CFPABot.IDK;
using CFPABot.PRData;
using CFPABot.ProjectHex;
using CFPABot.Utils;
using GammaLibrary.Extensions;
using Microsoft.AspNetCore.Server.Kestrel.Core;
using Microsoft.EntityFrameworkCore;
using Octokit;
using Serilog;
using Serilog.Events;
using System.Data;

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

            if (Environment.GetEnvironmentVariable("ASPNETCORE_ENVIRONMENT") == "Development")
            {
                Environment.CurrentDirectory = "C:\\app";
            }
            //GitHub.Init();
            Directory.CreateDirectory("config");
            Directory.CreateDirectory("userdata");
            Directory.CreateDirectory("config/pr_context");
            Directory.CreateDirectory("logs");
            Directory.CreateDirectory("config/repo_analyze_results");
            Directory.CreateDirectory("config/curse_files_cache");
            Directory.CreateDirectory("config/pr_cache");
            Directory.CreateDirectory("config/repo_cache");
            Directory.CreateDirectory("caches/");
            Directory.CreateDirectory("caches/repos/");
            Directory.CreateDirectory("project-hex");
            if (Environment.GetEnvironmentVariable("ASPNETCORE_ENVIRONMENT") != "Development")
                _ = Task.Run(async () =>
            {
                while (true)
                {
                    await ModList.ModListCache.Refresh();
                    await RunProjectHex();

                    await Task.Delay(TimeSpan.FromMinutes(5));
                }
            });
            if (Environment.GetEnvironmentVariable("ASPNETCORE_ENVIRONMENT") != "Development")
            {
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

                _ = Task.Run(async () =>
                {
                    while (true)
                    {
                        try
                        {
                            await TranslationRequestUpdater.Run();
                        }
                        catch (Exception e)
                        {
                            Console.WriteLine($"#2702 Error: {e}");
                        }

                        await Task.Delay(TimeSpan.FromMinutes(60));
                    }
                });
            }
                
            
            Log.Logger = new LoggerConfiguration()
                .MinimumLevel.Debug()
                .WriteTo.Console()
                .WriteTo.File("logs/myapp.txt", rollingInterval: RollingInterval.Day, restrictedToMinimumLevel: LogEventLevel.Information)
                //.WriteTo.File("logs/myapp-debug.txt", rollingInterval: RollingInterval.Day)
                .CreateLogger();
            await Init();
            try
            {
                var host = CreateHostBuilder(args).Build();
                using (var scope = host.Services.CreateScope())
                {
                    var db = scope.ServiceProvider.GetRequiredService<CFPABot.Christina.Backend.ChristinaDbContext>();
                    await EnsureChristinaDbSchemaAsync(db);
                }
                // Start daily LLM cache cleanup cron (stops when app shuts down)
                var scopeFactory = host.Services.GetRequiredService<IServiceScopeFactory>();
                _ = Task.Run(() => CronTask.RunDailyCleanupLoop(scopeFactory, cts.Token));
                await host.RunAsync(cts.Token);
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
                        await new ProjectHexRunner().Run(force);
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
            if (Environment.GetEnvironmentVariable("ASPNETCORE_ENVIRONMENT") != "Development")
                await PRDataManager.Init();
        }

        static async Task EnsureChristinaDbSchemaAsync(CFPABot.Christina.Backend.ChristinaDbContext db)
        {
            await db.Database.EnsureCreatedAsync();
            await AddColumnIfMissingAsync(db, "GlobalModelPresets", "SortOrder", "INTEGER NOT NULL DEFAULT 0");
            await AddColumnIfMissingAsync(db, "UserModelConfigs", "SortOrder", "INTEGER NOT NULL DEFAULT 0");
            await db.Database.ExecuteSqlRawAsync("UPDATE \"GlobalModelPresets\" SET \"SortOrder\" = \"Id\" WHERE \"SortOrder\" = 0;");
            await db.Database.ExecuteSqlRawAsync("UPDATE \"UserModelConfigs\" SET \"SortOrder\" = \"Id\" WHERE \"SortOrder\" = 0;");
        }

        static async Task AddColumnIfMissingAsync(CFPABot.Christina.Backend.ChristinaDbContext db, string tableName, string columnName, string columnDefinition)
        {
            if (columnName != "SortOrder" || columnDefinition != "INTEGER NOT NULL DEFAULT 0")
                throw new InvalidOperationException("Unsupported Christina schema update.");

            var connection = db.Database.GetDbConnection();
            var shouldClose = connection.State != ConnectionState.Open;
            if (shouldClose)
                await connection.OpenAsync();

            try
            {
                await using var command = connection.CreateCommand();
                command.CommandText = $"PRAGMA table_info(\"{tableName}\");";
                await using var reader = await command.ExecuteReaderAsync();
                while (await reader.ReadAsync())
                {
                    if (string.Equals(reader["name"]?.ToString(), columnName, StringComparison.OrdinalIgnoreCase))
                        return;
                }
            }
            finally
            {
                if (shouldClose)
                    await connection.CloseAsync();
            }

            var sql = tableName switch
            {
                "GlobalModelPresets" => "ALTER TABLE \"GlobalModelPresets\" ADD COLUMN \"SortOrder\" INTEGER NOT NULL DEFAULT 0;",
                "UserModelConfigs" => "ALTER TABLE \"UserModelConfigs\" ADD COLUMN \"SortOrder\" INTEGER NOT NULL DEFAULT 0;",
                _ => throw new InvalidOperationException("Unsupported Christina schema update.")
            };

            await db.Database.ExecuteSqlRawAsync(sql);
        }

        public static IHostBuilder CreateHostBuilder(string[] args) =>
            Host.CreateDefaultBuilder(args)
                .ConfigureWebHostDefaults(webBuilder =>
                {
                     webBuilder.ConfigureKestrel(x =>
                         x.ListenAnyIP(8080));
                    webBuilder.UseStartup<Startup>();
                });
    }
}
