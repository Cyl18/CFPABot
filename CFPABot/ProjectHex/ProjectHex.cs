﻿using CFPABot.Exceptions;
using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using CFPABot.Utils;
using GammaLibrary;
using GammaLibrary.Extensions;
using Octokit;
using Serilog;

namespace CFPABot.ProjectHex
{
    [ConfigurationPath("config/project-hex.json")]
    public class ProjectHexConfig : Configuration<ProjectHexConfig>
    {
        public DateTime LastTime { get; set; } = DateTime.Now - TimeSpan.FromDays(2);
        public int DownloadsSinceLastPack { get; set; } = 0;
        public int TotalDownloads { get; set; } = 0;
        public double TotalDownloadGBs { get; set; } = 0;

    }

    public class ProjectHexRunner
    {
        string RunDir = "caches/"+Guid.NewGuid().ToString("N").Substring(0, 6);
        public ProjectHexRunner()
        {
            Directory.CreateDirectory(RunDir);
        }


        public async Task Run(bool force = false)
        {
            var issueID = 2444;
            var issue = await GitHub.Instance.Issue.Get(Constants.RepoID, issueID);
            var body = issue.Body;
            body = body.Substring(0, body.LastIndexOf("->", StringComparison.Ordinal) + 2) + "\n\n";
            try
            {
                RunGitCommand("clone https://github.com/CFPAOrg/Minecraft-Mod-Language-Package.git .");
                RunGitCommand("config user.email cyl18a@gmail.com"); // 这里其实写谁的都无所谓 打包出来不会带 只是因为要 git commit 必须要写（
                RunGitCommand("config user.name Cyl18");

                RunGitCommand("checkout -b some-rannnnnndom-name");
                var sw = Stopwatch.StartNew();
                var prs = (await GitHub.Instance.PullRequest.GetAllForRepository(Constants.RepoID)).Where(p => !p.Draft).ToArray();
                var o = prs.Where(l => !l.Labels.Any(x => x.Name == "excluded-from-project-hex"))
                    .Select(x => $"pull/{x.Number}/head:pr-{x.Number}-{x.Head.Ref}").Connect(" ");
                RunGitCommand($"fetch origin {o}");
                foreach (var pr in prs)
                {
                    if (pr.Labels.Any(l => l.Name == "excluded-from-project-hex"))
                    {
                        Console.WriteLine($"Excluded PR: {pr.Number}");
                        continue;
                    }
                    //RunGitCommand($"fetch -f origin pull/{pr.Number}/head:{pr.Head.Ref}");
                    try
                    {
                        RunGitCommand($"merge -X theirs {pr.Head.Sha}");
                    }
                    catch (Exception e)
                    {
                        RunBashCommand($"-c \"yes m | git mergetool\"");
                        try
                        {
                            RunGitCommand($"commit -m umm");
                        }
                        catch (Exception exception)
                        {
                            Console.WriteLine(exception);
                        }
                    }
                }
                Console.WriteLine("运行 Packer 中");

                foreach (var value in Enum.GetValues<MCVersion>().TakeWhile(x => x < MCVersion.v121fabric))
                {
                    RunPacker(value);
                }
                Commit(force);
                body += $"> **Note**\n";
                body += $"> 最后更新时间: {(DateTime.UtcNow + TimeSpan.FromHours(8)):u}\n";
                body += $"> 打包所用时间: {sw.Elapsed.TotalMinutes:F1} min\n";
                body += $"> 总共处理PR数: {prs.Length}\n";
            }
            catch (Exception e)
            {
                body +=
                    "> **Warning**\n";
                body += $"> 最后更新时间: {(DateTime.UtcNow + TimeSpan.FromHours(8)):u}\n";
                body += $"> {e.ToString()}\n";
            }

            body += $"> 源服务器自上次打包后的下载次数: {ProjectHexConfig.Instance.DownloadsSinceLastPack}\n";
            body += $"> 源服务器总下载次数: {ProjectHexConfig.Instance.TotalDownloads}\n";
            body += $"> 源服务器总流量消耗: {ProjectHexConfig.Instance.TotalDownloadGBs:F2} GB\n";
            await GitHub.Instance.Issue.Update(Constants.RepoID, issueID, new IssueUpdate() {Body = body});

        }

        public void Commit(bool debug)
        {
            foreach (var file in Directory.GetFiles("project-hex"))
            {
                File.Delete(file);
            }
            foreach (var file in Directory.GetFiles($"{RunDir}/", "*.zip", SearchOption.TopDirectoryOnly))
            {
                Console.WriteLine($"Moving file {file}");
                File.Move(file, $"project-hex/{Path.GetFileNameWithoutExtension(file).TrimStart('.').TrimStart('/').TrimStart('\\')}-{File.ReadAllBytes(file).SHA256().ToHexString().Substring(0,6)}.zip");
            }

            if (!debug)
            {
                Directory.Delete(RunDir, true);
            }
        }
        void RunBashCommand(string args)
        {
            var process = Process.Start(new ProcessStartInfo("bash", args) { RedirectStandardOutput = true, RedirectStandardError = true, WorkingDirectory = RunDir });
            var stdout = "";
            var stderr = "";
            Console.WriteLine($"bash {args}");
            process.OutputDataReceived += (sender, eventArgs) => { stdout += eventArgs.Data; };
            process.ErrorDataReceived += (sender, eventArgs) => { stderr += eventArgs.Data; };
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            process.WaitForExit();
            if (process.ExitCode != 0)
            {
                // haha
                // https://github.com/Cyl18/CFPABot/issues/3
                // maybe Regex.Replace(message, "ghs_[0-9a-zA-Z]{36}", "******")
                Log.Error($"git.exe {args} exited with {process.ExitCode} - {stdout}{stderr}");
                throw new ProcessException($"git.exe with args `{args}` exited with {process.ExitCode} {stdout}{stderr}.");
            }

        }

        void RunGitCommand(string args)
        {
            Console.WriteLine($"git {args}");

            var process = Process.Start(new ProcessStartInfo("git", args) { RedirectStandardOutput = true, RedirectStandardError = true, WorkingDirectory = RunDir });
            var stdout = "";
            var stderr = "";
            process.OutputDataReceived += (sender, eventArgs) => { stdout += eventArgs.Data; };
            process.ErrorDataReceived += (sender, eventArgs) => { stderr += eventArgs.Data; };
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            process.WaitForExit();
            if (process.ExitCode != 0)
            {
                // haha
                // https://github.com/Cyl18/CFPABot/issues/3
                // maybe Regex.Replace(message, "ghs_[0-9a-zA-Z]{36}", "******")
                Log.Error($"git.exe {args} exited with {process.ExitCode} - {stdout}{stderr}");
                throw new ProcessException($"git.exe with args `{args}` exited with {process.ExitCode} {stdout}{stderr}.");
            }

        }

        void RunPacker(MCVersion version)
        {
            var process = Process.Start(new ProcessStartInfo("Packer", $"--version=\"{version.ToVersionString()}\"") { WorkingDirectory = RunDir, RedirectStandardOutput = true});
            
            var stdout = process.StandardOutput;
            
            if (version == MCVersion.v1122)
            {
                using var fs = File.OpenWrite("logs/packer-1.12.2.log");
                stdout.BaseStream.CopyTo(fs);
            }
            else
            {
                stdout.ReadToEnd();
            }

            process.WaitForExit();
        }
    }
}
