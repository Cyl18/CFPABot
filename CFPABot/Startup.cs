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
using BlazorStrap;
using CFPABot.Controllers;
using CFPABot.ProjectHex;
using CFPABot.Utils;
using MessagePack;
using Microsoft.AspNetCore.Http;
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
            services.AddRazorPages(options => options.RootDirectory = "/Azusa/Pages");
            services.AddServerSideBlazor();
            services.AddControllers();
            services.AddDirectoryBrowser();
            services.AddHealthChecks();
            services.AddBlazorStrap();
            services.AddSignalR(e => {
                e.MaximumReceiveMessageSize = 102400000;
                
            })
                .AddMessagePackProtocol(options => options.SerializerOptions = MessagePackSerializerOptions.Standard.WithCompression(MessagePackCompression.Lz4Block).WithSecurity(MessagePackSecurity.UntrustedData)); ;
            services.AddHttpContextAccessor();
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

            app.UseDirectoryBrowser(new DirectoryBrowserOptions() { RequestPath = "/project-hex", FileProvider = new PhysicalFileProvider("/app/project-hex") });

            app.UseStaticFiles(new StaticFileOptions()
            {
                RequestPath = "/christina",
                FileProvider = new ManifestEmbeddedFileProvider(
                    typeof(Program).Assembly, "Christina"
                )
            });

            app.UseStaticFiles(new StaticFileOptions
            {
                RequestPath = "/static",
                FileProvider = new PhysicalFileProvider(Path.GetFullPath("wwwroot")),
                OnPrepareResponse =
                    context =>
                    {
                    }
            });
            if (Environment.GetEnvironmentVariable("ASPNETCORE_ENVIRONMENT") != "Development")
            {
                app.UseStaticFiles(new StaticFileOptions
                {
                    RequestPath = "/css",
                    FileProvider = new PhysicalFileProvider(Path.GetFullPath("wwwrootx/css")),
                    
                });
            }
            
            app.UseStaticFiles(new StaticFileOptions()
            {
                RequestPath = "/project-hex",
                FileProvider = new PhysicalFileProvider("/app/project-hex"),
                ServeUnknownFileTypes = true,
                OnPrepareResponse =
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
            app.UseStaticFiles();

            app.UseFileServer(new FileServerOptions
            {
                FileProvider = new ManifestEmbeddedFileProvider(
                    typeof(Program).Assembly, "Azusa/wwwroot"
                )
            });
            app.UseFileServer(new FileServerOptions
            {
                FileProvider = new ManifestEmbeddedFileProvider(
                    typeof(Program).Assembly, "Azusa/wwwroot"
                ),
                RequestPath = new PathString("/Azusa")
            });
            app.UseFileServer(new FileServerOptions
            {
                FileProvider = new ManifestEmbeddedFileProvider(
                    typeof(Program).Assembly, "Azusa/wwwroot2"
                ),
                RequestPath = new PathString("/Azusa")
            });

            app.UseRouting();

            app.UseAuthorization();
            
           

            app.UseEndpoints(endpoints =>
            {
                endpoints.MapGitHubWebhooks("api/WebhookListener", Constants.GitHubWebhookSecret);
                endpoints.MapControllers(); 
                endpoints.MapBlazorHub("/Azusa/_blazor");
                endpoints.MapFallbackToPage("/_Host");
            });




        }
    }
}
