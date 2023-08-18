using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using CFPABot.Exceptions;
using CFPABot.Utils;
using Serilog;

namespace CFPABot.Azusa
{
    public sealed class ForkRepoManager : IDisposable
    {
        string _token;
        public string WorkingDirectory { get; }

        public ForkRepoManager(string token)
        {
            WorkingDirectory = $"/app/caches/repos/{Guid.NewGuid():N}";
            _token = token;
            Directory.CreateDirectory(WorkingDirectory);
        }

        public void Clone(string repoOwner, string repoName, string userName = null, string userEmail = null)
        {
            Run($"clone https://x-access-token:{_token}@github.com/{repoOwner}/{repoName}.git --depth=1 .");
            if (userEmail != null)
            {
                Run($"config user.name \"{userName}\"");
                Run($"config user.email \"{userEmail}\"");   
            }
        }
        

        public void Commit(string message)
        {
            Run("commit -m \"" +
                $"{message.Replace('\"', '*')}" +
                "\"");
        }

        public void Push()
        {
            Run("push");
        }

        public void AddAllFiles()
        {
            Run("add -A");
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

        public void Dispose()
        {
            try
            {
                Directory.Delete(WorkingDirectory, true);
            }
            catch (Exception e)
            {
                Log.Warning(e, "clean git repo");
            }
        }
    }
}
