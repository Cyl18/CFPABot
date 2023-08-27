using System.IO;
using System;
using CFPABot.Exceptions;
using System.Diagnostics;
using System.Threading.Tasks;
using Serilog;

namespace CFPABot.Utils
{
    public class GlobalGitRepoCache
    {

        public string WorkingDirectory { get; }
        
        public GlobalGitRepoCache()
        {
            WorkingDirectory = $"/app/repo-cache";
            Directory.CreateDirectory(WorkingDirectory);
        }

        public Task Clone()
        {
            return Task.Run(() =>
            {
                if (!File.Exists(WorkingDirectory + "/README.md"))
                {
                    Run(
                        $"clone https://x-access-token:{GitHub.GetToken()}@github.com/{Constants.Owner}/{Constants.RepoName}.git --depth=1 .");
                }
            });
        }


        public void Run(string args)
        {
            var process = Process.Start(new ProcessStartInfo("git", args) { RedirectStandardOutput = true, RedirectStandardError = true, WorkingDirectory = WorkingDirectory });
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
                throw new ProcessException($"git.exe with args `{args}` exited with {process.ExitCode}.");
            }

        }
    }
}
