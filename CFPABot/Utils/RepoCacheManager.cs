using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO;
using System.Text.RegularExpressions;
using CFPABot.Exceptions;
using Serilog;

namespace CFPABot.Utils
{
    public static class RepoCacheManager
    {
        static readonly ConcurrentDictionary<string, object> RepoLocks = new();

        public static string CacheRootDirectory => Path.GetFullPath(Path.Combine("config", "repo_cache"));

        public static string EnsureReady(string owner, string repoName, string token = null)
        {
            Directory.CreateDirectory(CacheRootDirectory);

            var cacheDirectory = GetCacheDirectory(owner, repoName);
            var repoLock = RepoLocks.GetOrAdd($"{owner}/{repoName}".ToLowerInvariant(), _ => new object());

            lock (repoLock)
            {
                try
                {
                    EnsureReadyCore(owner, repoName, token, cacheDirectory);
                }
                catch (Exception ex) when (Directory.Exists(cacheDirectory))
                {
                    Log.Warning(ex, "Repo cache refresh failed for {Owner}/{RepoName}, rebuilding cache", owner, repoName);
                    DeleteDirectory(cacheDirectory);
                    EnsureReadyCore(owner, repoName, token, cacheDirectory);
                }
            }

            return cacheDirectory;
        }

        public static string EnsureReferenceCache(string repoOwner, string repoName, string token = null)
        {
            if (string.Equals(repoName, Constants.RepoName, StringComparison.OrdinalIgnoreCase))
            {
                return EnsureReady(Constants.Owner, Constants.RepoName, token);
            }

            return EnsureReady(repoOwner, repoName, token);
        }

        public static string GetCacheDirectory(string owner, string repoName)
        {
            return Path.Combine(CacheRootDirectory, $"{SanitizePathSegment(owner)}_{SanitizePathSegment(repoName)}");
        }

        static void EnsureReadyCore(string owner, string repoName, string token, string cacheDirectory)
        {
            if (!Directory.Exists(cacheDirectory) || !IsValidRepository(cacheDirectory, owner, repoName))
            {
                DeleteDirectory(cacheDirectory);
                Directory.CreateDirectory(cacheDirectory);
                CloneRepository(cacheDirectory, owner, repoName, token);
                return;
            }

            RefreshRepository(cacheDirectory, owner, repoName, token);
        }

        static bool IsValidRepository(string cacheDirectory, string owner, string repoName)
        {
            if (!Directory.Exists(cacheDirectory) || !Directory.Exists(Path.Combine(cacheDirectory, ".git")))
            {
                return false;
            }

            try
            {
                var isInsideWorkTree = RunGit(cacheDirectory, "rev-parse --is-inside-work-tree", throwOnError: true).Trim();
                if (!string.Equals(isInsideWorkTree, "true", StringComparison.OrdinalIgnoreCase))
                {
                    return false;
                }

                var remoteUrl = RunGit(cacheDirectory, "remote get-url origin", throwOnError: true).Trim();
                return RemoteMatches(remoteUrl, owner, repoName);
            }
            catch (Exception ex)
            {
                Log.Warning(ex, "Repo cache validation failed for {Owner}/{RepoName}", owner, repoName);
                return false;
            }
        }

        static void CloneRepository(string cacheDirectory, string owner, string repoName, string token)
        {
            RunGit(cacheDirectory, $"clone {BuildRepoUrl(owner, repoName, token)} .", throwOnError: true);
            RefreshRepository(cacheDirectory, owner, repoName, token);
        }

        static void RefreshRepository(string cacheDirectory, string owner, string repoName, string token)
        {
            RunGit(cacheDirectory, $"remote set-url origin {BuildRepoUrl(owner, repoName, token)}", throwOnError: true);
            RunGit(cacheDirectory, "fetch --prune origin +refs/heads/*:refs/remotes/origin/*", throwOnError: true);
            RunGit(cacheDirectory, "remote set-head origin -a", throwOnError: false);

            var defaultBranch = GetDefaultBranch(cacheDirectory);
            if (defaultBranch == null)
            {
                return;
            }

            RunGit(cacheDirectory, $"checkout -B {defaultBranch} origin/{defaultBranch}", throwOnError: true);
            RunGit(cacheDirectory, $"reset --hard origin/{defaultBranch}", throwOnError: true);
            RunGit(cacheDirectory, "clean -fd", throwOnError: true);
        }

        static string GetDefaultBranch(string cacheDirectory)
        {
            var headRef = RunGit(cacheDirectory, "symbolic-ref --short refs/remotes/origin/HEAD", throwOnError: false).Trim();
            if (headRef.StartsWith("origin/", StringComparison.Ordinal))
            {
                return headRef["origin/".Length..];
            }

            foreach (var branchName in new[] { "main", "master" })
            {
                var result = RunGit(cacheDirectory, $"show-ref refs/remotes/origin/{branchName}", throwOnError: false);
                if (!string.IsNullOrWhiteSpace(result))
                {
                    return branchName;
                }
            }

            return null;
        }

        static bool RemoteMatches(string remoteUrl, string owner, string repoName)
        {
            if (string.IsNullOrWhiteSpace(remoteUrl))
            {
                return false;
            }

            var normalized = NormalizeRemoteUrl(remoteUrl);
            var expected = NormalizeRemoteUrl($"{owner}/{repoName}.git");
            return string.Equals(normalized, expected, StringComparison.OrdinalIgnoreCase);
        }

        static string NormalizeRemoteUrl(string url)
        {
            var trimmed = url.Trim();
            trimmed = Regex.Replace(trimmed, @"^(https?://)([^/@]+@)", "$1", RegexOptions.IgnoreCase);
            trimmed = trimmed.TrimEnd('/');

            if (trimmed.StartsWith("git@github.com:", StringComparison.OrdinalIgnoreCase))
            {
                return trimmed["git@github.com:".Length..];
            }

            const string githubHostSegment = "github.com/";
            var hostIndex = trimmed.IndexOf(githubHostSegment, StringComparison.OrdinalIgnoreCase);
            if (hostIndex >= 0)
            {
                return trimmed[(hostIndex + githubHostSegment.Length)..];
            }

            return trimmed;
        }

        static string BuildRepoUrl(string owner, string repoName, string token)
        {
            token ??= GitHub.GetToken();
            return string.IsNullOrWhiteSpace(token)
                ? $"https://github.com/{owner}/{repoName}.git"
                : $"https://x-access-token:{token}@github.com/{owner}/{repoName}.git";
        }

        static string RunGit(string workingDirectory, string args, bool throwOnError)
        {
            var process = Process.Start(new ProcessStartInfo("git", args)
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                WorkingDirectory = workingDirectory
            });

            var stdout = process.StandardOutput.ReadToEnd();
            var stderr = process.StandardError.ReadToEnd();
            process.WaitForExit();

            if (process.ExitCode != 0)
            {
                Log.Warning("git.exe {Args} exited with {ExitCode} - {Stdout}{Stderr}", args, process.ExitCode, stdout, stderr);
                if (throwOnError)
                {
                    throw new ProcessException($"git.exe with args `{args}` exited with {process.ExitCode}.");
                }
            }

            return stdout;
        }

        static string SanitizePathSegment(string value)
        {
            foreach (var invalidChar in Path.GetInvalidFileNameChars())
            {
                value = value.Replace(invalidChar, '_');
            }

            return value;
        }

        static void DeleteDirectory(string path)
        {
            if (!Directory.Exists(path))
            {
                return;
            }

            Directory.Delete(path, true);
        }
    }
}
