using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using CFPABot.Exceptions;
using CFPABot.Utils;
using Serilog;

namespace CFPABot.Command
{
    public sealed class GitRepoManager : IDisposable
    {
        public string WorkingDirectory { get; }

        public GitRepoManager()
        {
            WorkingDirectory = $"/app/caches/repos/{Guid.NewGuid():N}";
            Directory.CreateDirectory(WorkingDirectory);
        }

        public void Clone(string repoOwner, string repoName, string branchName)
        {
            Run($"clone https://x-access-token:{GitHub.GetToken()}@github.com/{repoOwner}/{repoName}.git --depth=1 . -b {branchName}");
            Run("config user.name \"cfpa-bot[bot]\"");
            Run("config user.email \"101878103+cfpa-bot[bot]@users.noreply.github.com\"");
        }

        public static string[] SplitArguments(string commandLine)
        {
            var parmChars = commandLine.ToCharArray();
            var inSingleQuote = false;
            var inDoubleQuote = false;
            for (var index = 0; index < parmChars.Length; index++)
            {
                if (parmChars[index] == '"' && !inSingleQuote)
                {
                    inDoubleQuote = !inDoubleQuote;
                    parmChars[index] = '\n';
                }
                if (parmChars[index] == '\'' && !inDoubleQuote)
                {
                    inSingleQuote = !inSingleQuote;
                    parmChars[index] = '\n';
                }
                if (!inSingleQuote && !inDoubleQuote && parmChars[index] == ' ')
                    parmChars[index] = '\n';
            }
            return (new string(parmChars)).Split(new[] { '\n' }, StringSplitOptions.RemoveEmptyEntries);
        }

        public void Commit(string message, GitHubUser coAuthor)
        {
            Run("commit -m \"" +
                $"{message}\n\n" +
                $"Co-authored-by: {coAuthor.Login} <{coAuthor.ID}+{coAuthor.Login}@users.noreply.github.com>" +
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
