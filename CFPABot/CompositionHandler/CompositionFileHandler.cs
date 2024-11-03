using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Text;
using System.Threading.Tasks;
using CFPABot.Azusa;
using GammaLibrary.Extensions;
using NuGet.ContentModel;
using Octokit;

namespace CFPABot.CompositionHandler
{
    public class CompositionFileHandler : IDisposable
    {

        private ForkRepoManager repo = new ForkRepoManager();
        public CompositionFileHandler(PullRequest pr)
        {
            this.pr = pr;
        }

        private bool inited = false;
        private PullRequest pr;

        private void Init()
        {
            if (inited) return;
            inited = true;

            repo.Clone(pr.Head.User.Login, pr.Head.Repository.Name, branch: pr.Head.Ref);
        }

        private List<string> packedVersions = new List<string>();
        public string AcquireLangFile(string curseId, string modid, string versionString)
        {
            Init();
            RunPacker(versionString);
            using var zipArchive = new ZipArchive(File.OpenRead(Path.Combine(repo.WorkingDirectory, $"Minecraft-Mod-Language-Package-{versionString}.zip")), ZipArchiveMode.Read, false, Encoding.UTF8);
            foreach (var entry in zipArchive.Entries)
            {
                if (entry.FullName.Equals($"projects/{versionString}/assets/{curseId}/{modid}/lang/zh_cn.lang", StringComparison.OrdinalIgnoreCase) || 
                    entry.FullName.Equals($"projects/{versionString}/assets/{curseId}/{modid}/lang/zh_cn.json", StringComparison.OrdinalIgnoreCase))
                {
                    return entry.Open().ReadToEnd();
                }
            }

            throw new FileNotFoundException($"找不到 {curseId}/{modid}/{versionString} 的组合文件");
        }

        void RunPacker(string versionString)
        {
            if (packedVersions.Contains(versionString))
            {
                return;
            }
            packedVersions.Add(versionString);
            var process = Process.Start(new ProcessStartInfo("Packer", $"--version=\"{versionString}\"") { WorkingDirectory = repo.WorkingDirectory, RedirectStandardOutput = true });
            process.StandardOutput.ReadToEnd();
            process.WaitForExit();
        }

        public void Dispose()
        {
            repo?.Dispose();
        }
    }
}
