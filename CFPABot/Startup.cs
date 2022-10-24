using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using CFPABot.Controllers;
using CFPABot.ProjectHex;
using CFPABot.Utils;
using Microsoft.Extensions.FileProviders;
using Octokit.Webhooks;
using Octokit.Webhooks.AspNetCore;

namespace CFPABot
{
    public class Startup
    {
        public Startup(IConfiguration configuration)
        {
            Configuration = configuration;
        }

        public IConfiguration Configuration { get; }

        // This method gets called by the runtime. Use this method to add services to the container.
        public void ConfigureServices(IServiceCollection services)
        {

            services.AddControllers();
            services.AddHealthChecks(); 
            services.AddSingleton<WebhookEventProcessor, MyWebhookEventProcessor>();
        }

        // This method gets called by the runtime. Use this method to configure the HTTP request pipeline.
        public void Configure(IApplicationBuilder app, IWebHostEnvironment env)
        {
            if (env.IsDevelopment())
            {
                app.UseDeveloperExceptionPage();
            }

            app.UseHealthChecks("/healthcheck");

            app.UseRouting();

            app.UseAuthorization();
            
            app.UseStaticFiles(new StaticFileOptions { RequestPath = "/static", FileProvider = new PhysicalFileProvider(Path.GetFullPath("wwwroot")), OnPrepareResponse =
                context =>
                {
                }});
            app.UseStaticFiles(new StaticFileOptions()
                {RequestPath = "/project-hex", FileProvider = new PhysicalFileProvider("/app/project-hex"), ServeUnknownFileTypes = true, OnPrepareResponse =
                    context =>
                    {
                        lock (ProjectHexConfig.Instance)
                        {
                            ProjectHexConfig.Instance.DownloadsSinceLastPack++;
                            ProjectHexConfig.Instance.TotalDownloads++;
                            ProjectHexConfig.Instance.TotalDownloadGBs += context.File.Length / 1024.0 / 1024.0 / 1024.0;
                            ProjectHexConfig.Save();
                        }
                        Console.WriteLine($"Downloading {context.File.Name}");
                    }
            });
            app.UseDirectoryBrowser(new DirectoryBrowserOptions() { RequestPath = "/project-hex", FileProvider = new PhysicalFileProvider("/app/project-hex")});

            app.UseEndpoints(endpoints =>
            {
                endpoints.MapGitHubWebhooks("api/WebhookListener", Constants.GitHubWebhookSecret);
                endpoints.MapControllers();
            });
        }
    }
}
