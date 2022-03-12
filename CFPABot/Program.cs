using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using CFPABot.Utils;
using Serilog;
using Serilog.Events;

namespace CFPABot
{
    public class Program
    {
        public static async Task Main(string[] args)
        {
            GitHub.Init();
            Directory.CreateDirectory("config");
            Directory.CreateDirectory("wwwroot");
            Directory.CreateDirectory("config/pr_context");
            Directory.CreateDirectory("logs");
            Log.Logger = new LoggerConfiguration()
                .MinimumLevel.Debug()
                .WriteTo.Console()
                .WriteTo.File("logs/myapp.txt", rollingInterval: RollingInterval.Day, restrictedToMinimumLevel: LogEventLevel.Information)
                .WriteTo.File("logs/myapp-debug.txt", rollingInterval: RollingInterval.Day)
                .CreateLogger();
            await Init();
            await CreateHostBuilder(args).Build().RunAsync();
        }

        static async Task Init()
        {
            Log.Information("正在加载 mapping..");
            if (ModIDMappingMetadata.Instance.Mapping.Count == 0)
            {
                Log.Information("开始构建 mapping..");
                await CurseForgeIDMappingManager.Build();
            }
            Log.Information("mapping 加载完成");
        }

        public static IHostBuilder CreateHostBuilder(string[] args) =>
            Host.CreateDefaultBuilder(args)
                .ConfigureWebHostDefaults(webBuilder =>
                {
                    webBuilder.UseStartup<Startup>();
                });
    }
}
