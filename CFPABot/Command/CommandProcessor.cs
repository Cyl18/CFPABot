using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using CFPABot.DiffEngine;
using CFPABot.Exceptions;
using CFPABot.Resources;
using CFPABot.Utils;
using GammaLibrary.Extensions;
using Language.Core;
using Newtonsoft.Json.Linq;
using Octokit;
using Serilog;
using FileMode = System.IO.FileMode;

namespace CFPABot.Command
{
    public record GitHubUser(string Login, long ID);

    public static class CommandProcessor
    {
        static int currentRuns = 0;
        internal static int CurrentRuns => currentRuns;
        public static async Task Run(int prid, string content, int commentID, GitHubUser user)
        {
            try
            {
                Interlocked.Increment(ref currentRuns);
                await RunInternal(prid, content, commentID, user);
            }
            finally
            {
                Interlocked.Decrement(ref currentRuns);
            }
        }
        // https://stackoverflow.com/questions/3825390/effective-way-to-find-any-files-encoding
        public static Encoding GetEncoding(string filename)
        {
            // Read the BOM
            var bom = new byte[4];
            using (var file = new FileStream(filename, FileMode.Open, FileAccess.Read))
            {
                file.Read(bom, 0, 4);
            }

            // Analyze the BOM
            if (bom[0] == 0x2b && bom[1] == 0x2f && bom[2] == 0x76) return Encoding.UTF7;
            if (bom[0] == 0xef && bom[1] == 0xbb && bom[2] == 0xbf) return Encoding.UTF8;
            if (bom[0] == 0xff && bom[1] == 0xfe && bom[2] == 0 && bom[3] == 0) return Encoding.UTF32; //UTF-32LE
            if (bom[0] == 0xff && bom[1] == 0xfe) return Encoding.Unicode; //UTF-16LE
            if (bom[0] == 0xfe && bom[1] == 0xff) return Encoding.BigEndianUnicode; //UTF-16BE
            if (bom[0] == 0 && bom[1] == 0 && bom[2] == 0xfe && bom[3] == 0xff) return new UTF32Encoding(true, true);  //UTF-32BE

            // We actually have no idea what the encoding is if we reach this point, so
            // you may wish to return null instead of defaulting to ASCII
            return new UTF8Encoding(false);
        }
        public static async Task RunInternal(int prid, string content, int commentID, GitHubUser user)
        {
            

            //bool addedReaction = false;
            var sb = new StringBuilder();
            var pr = await GitHub.GetPullRequest(prid);
            var repo = new Lazy<GitRepoManager>(() => new GitRepoManager());
            try
            {
                foreach (var line in content.Split("\r\n"))
                {
                    if (!line.StartsWith("/")) continue;

                    if (line.StartsWith("/rename "))
                    {
                        if (!await CheckPermission()) continue;
                        var arg = line["/rename ".Length..];
                        var r = GetRepo();
                        var args = GitRepoManager.SplitArguments(arg);
                        if (args.Any(x => x.Contains(".."))) throw new CommandException("¿");
                        
                        var from = Path.Combine(r.WorkingDirectory, args[0]);
                        if (!File.Exists(from))
                        {
                            throw new CommandException("文件不存在。");
                        }
                        var to = Path.Combine(r.WorkingDirectory, args[1]);
                        File.Move(from, to, true);
                        
                        r.AddAllFiles();
                        r.Commit($"mv {(arg.Replace("\"", "\\\""))}", user);
                    }
                    
                    if (line.StartsWith("/mv "))
                    {
                        if (!await CheckPermission()) continue;
                        var arg = line["/mv ".Length..];
                        var r = GetRepo();
                        var args = GitRepoManager.SplitArguments(arg);
                        if (args.Any(x => x.Contains(".."))) throw new CommandException("¿");
                        Directory.CreateDirectory(Path.Combine(r.WorkingDirectory, Path.GetDirectoryName(args[1])));
                        foreach (var path in args)
                        {
                            var baseDir = Path.GetFullPath(r.WorkingDirectory);
                            if (!Path.GetFullPath(path, baseDir).StartsWith(baseDir))
                            {
                                throw new CommandException(Locale.Command_mv_SecurityCheckFailure);
                            }
                        }

                        if (args.Length != 2) throw new CommandException("应该有两个参数。");

                        var from = Path.Combine(r.WorkingDirectory, args[0]);
                        var to = Path.Combine(r.WorkingDirectory, args[1]);
                        var tmpdir = $"caches/{Guid.NewGuid():N}/";
                        Directory.CreateDirectory(tmpdir);
                        // copy [from] to [tmpdir]
                        
                        foreach (var file in Directory.GetFiles(from, "*", SearchOption.AllDirectories))
                        {
                            var dst = Path.Combine(tmpdir, Path.GetRelativePath(from, file));
                            Directory.CreateDirectory(Path.GetDirectoryName(dst));
                            File.Move(file, dst, true);
                        }

                        foreach (var file in Directory.GetFiles(tmpdir, "*", SearchOption.AllDirectories))
                        {
                            var dst = Path.Combine(to, Path.GetRelativePath(tmpdir, file));
                            Directory.CreateDirectory(Path.GetDirectoryName(dst));
                            File.Move(file, dst, true);
                        }

                        r.AddAllFiles();
                        r.Commit($"mv {(arg.Replace("\"", "\\\""))}", user);
                        Directory.Delete(tmpdir, true);
                    }

                    if (line.StartsWith("/update-en "))
                    {
                        if (!await CheckPermission()) continue;
                        var args = line["/update-en ".Length..].Split(" ", StringSplitOptions.RemoveEmptyEntries);
                        var r = GetRepo();
                        var curseForgeID = args[0];
                        var versionString = args[1];
                        var version = args[1].ToMCVersion();
                        var versionFile = version switch
                        {
                            MCVersion.v1122 => "en_us.lang",
                            _ => "en_us.json"
                        };
                        if (curseForgeID.StartsWith("modrinth-"))
                        {
                            curseForgeID = curseForgeID["modrinth-".Length..];
                            var addon = await ModrinthManager.GetMod(curseForgeID);

                            var modID = await ModrinthManager.GetModID(addon, version, true, false);
                            var (files, downloadFileName) = await ModrinthManager.GetModEnFile(addon, version, LangType.EN);
                            if (files.Length != 1)
                            {
                                sb.AppendLine(Locale.Command_update_en_MultipleLangFiles);
                                continue;
                            }

                            sb.AppendLine(string.Format(Locale.Command_update_en_Success, downloadFileName));
                            var f = files[0];
                            using var sr = new MemoryStream(f.ToUTF8Bytes()).CreateStreamReader(Encoding.UTF8);
                            using var sw = File.Open(
                                Path.Combine(r.WorkingDirectory,
                                    $"projects/{versionString}/assets/{curseForgeID}/{modID}/lang/{versionFile}"),
                                FileMode.Create).CreateStreamWriter(new UTF8Encoding(false));

                            switch (version)
                            {
                                case MCVersion.v1122:
                                    new LangFormatter(sr, sw).Format();
                                    break;
                                default:
                                    new JsonFormatter(sr, sw).Format();
                                    break;
                            }

                            r.AddAllFiles();
                            r.Commit($"Update en_us file for {(curseForgeID.Replace("\"", "\\\""))}", user);
                        }
                        else
                        {
                            var addon = await CurseManager.GetAddon(curseForgeID);

                            var modID = await CurseManager.GetModID(addon, version, true, false);
                            var (files, downloadFileName) = await CurseManager.GetModEnFile(addon, version, LangType.EN);
                            if (files.Length != 1)
                            {
                                sb.AppendLine(Locale.Command_update_en_MultipleLangFiles);
                                continue;
                            }

                            sb.AppendLine(string.Format(Locale.Command_update_en_Success, downloadFileName));
                            var f = files[0];
                            using var sr = new MemoryStream(f.ToUTF8Bytes()).CreateStreamReader(Encoding.UTF8);
                            using var sw = File.Open(
                                Path.Combine(r.WorkingDirectory,
                                    $"projects/{versionString}/assets/{curseForgeID}/{modID}/lang/{versionFile}"),
                                FileMode.Create).CreateStreamWriter(new UTF8Encoding(false));

                            switch (version)
                            {
                                case MCVersion.v1122:
                                    new LangFormatter(sr, sw).Format();
                                    break;
                                default:
                                    new JsonFormatter(sr, sw).Format();
                                    break;
                            }

                            r.AddAllFiles();
                            r.Commit($"Update en_us file for {(curseForgeID.Replace("\"", "\\\""))}", user);
                        }
                        
                    }

                    if (line.StartsWith("/add-co-author "))
                    {
                        if (!await CheckPermission()) continue;
                        var userLogin = line["/add-co-author ".Length..].Trim('@').Trim();
                        User coAuthor;
                        try
                        {
                            coAuthor = await GitHub.Instance.User.Get(userLogin);
                        }
                        catch (Exception e)
                        {
                            sb.AppendLine("无法获取到指定用户。");
                            continue;
                        }
                        var r = GetRepo();

                        r.Run("commit --allow-empty -m \"" +
                                       $"别看我，我只是个协作\n\n" +
                                       $"Co-authored-by: {coAuthor.Login} <{coAuthor.Id}+{coAuthor.Login}@users.noreply.github.com>" +
                                       "\"");
                    }

                    
                    if (line == "/revert")
                    {
                        if (!await CheckPermission()) continue;
                        var r = GetRepo();
                    
                        r.Run($"revert --no-edit HEAD");
                        r.Push();
                    }

                    if (line.StartsWith("/revert "))
                    {
                        if (!await CheckPermission()) continue;
                        var r = GetRepo(noDepth: true);
                        var hash = line["/revert ".Length..].Trim('"');

                        r.Run($"revert --no-edit {hash}");
                        r.Push();
                    }


                    if (line.StartsWith("/format "))
                    {
                        if (!await CheckPermission()) continue;
                        throw new CommandException("/format 临时关闭。");
                        var filePath = line["/format ".Length..].Trim('"');
                        var r = GetRepo();
                        var repoPath = Path.Combine(r.WorkingDirectory, filePath);
                        if (filePath == "*")
                        {
                            var diff = await GitHub.Diff(prid);
                            foreach (var fileDiff in diff.Where(x => x.To.EndsWith(".json") || x.To.EndsWith(".lang")))
                            {
                                LangFilePath langFilePath = null;
                                try
                                {
                                    langFilePath = new LangFilePath(fileDiff.To);
                                }
                                catch (Exception e)
                                {
                                    continue;
                                }

                                repoPath = Path.Combine(r.WorkingDirectory, fileDiff.To);
                                Format(langFilePath.LangFileType);
                            }

                        }
                        else
                        {
                            Format();
                        }

                        void Format(LangFileType? type = null)
                        {
                            if (type != null)
                            {
                                switch (type)
                                {
                                    case LangFileType.Lang:
                                        File.WriteAllText(repoPath, ExFormatter.Format(File.ReadAllText(repoPath), LangFileType.Lang));
                                        break;
                                    case LangFileType.Json:
                                        File.WriteAllText(repoPath, ExFormatter.Format(File.ReadAllText(repoPath), LangFileType.Json));
                                        break;
                                }
                            }
                            else
                            {
                                switch (filePath.Split("/")[1].ToMCVersion())
                                {
                                    case MCVersion.v1122:
                                        File.WriteAllText(repoPath, ExFormatter.Format(File.ReadAllText(repoPath), LangFileType.Lang));
                                        break;
                                    default:
                                        File.WriteAllText(repoPath, ExFormatter.Format(File.ReadAllText(repoPath), LangFileType.Json));
                                        break;
                                }
                            }
                            

                        }

                        r.AddAllFiles();
                        r.Commit($"Reformat file", user);
                    }

                    if (line.StartsWith("/replace "))
                    {
                        if (!await CheckPermission()) continue;
                        var args = GitRepoManager.SplitArguments(line["/replace ".Length..]);
                        var r = GetRepo();
                        if (args.Length != 2) throw new CommandException("应该有两个参数。");
                        var diffs = await GitHub.Diff(prid);
                        foreach (var diff in diffs)
                        {
                            var filePath = Path.Combine(r.WorkingDirectory, diff.To);
                            if (!Path.GetFileName(filePath).Contains("zh_"))
                            {
                                continue;
                            }
                            if (filePath.EndsWith("json"))
                            {
                                var json = JsonDocument.Parse(File.ReadAllText(filePath));
                                var jo = new JObject();

                                foreach (var property in json.RootElement.EnumerateObject())
                                {
                                    jo.Add(property.Name, property.Value.GetString().Replace(args[0], args[1]));
                                }
                                File.WriteAllText(filePath, jo.ToString());
                            }
                            else
                            {
                                File.WriteAllText(filePath, File.ReadAllText(filePath).Replace(args[0], args[1]));
                            }
                        }

                        r.AddAllFiles();
                        r.Commit($"Replace '{args[0]}' with '{args[1]}'", user);
                    }
                    
                    if (line.StartsWith("/add-comment "))
                    {
                        if (!await CheckPermission()) continue;
                        var args = GitRepoManager.SplitArguments(line["/add-comment ".Length..]);
                        var r = GetRepo();
                        if (args.Length < 2) throw new CommandException("应该大于2个参数。");
                        // key, comment
                        var keyPart = args[0];
                        var comment = args.Skip(1).Connect(" ");
                        var flag = false;
                        var diffs = await GitHub.Diff(prid);
                        foreach (var diff in diffs)
                        {
                            var filePath = Path.Combine(r.WorkingDirectory, diff.To);
                            if (!Path.GetFileName(filePath).Contains("zh_"))
                            {
                                continue;
                            }
                            if (filePath.EndsWith("json"))
                            {
                                Encoding encoding = GetEncoding(filePath);

                                var lines = File.ReadAllLines(filePath, encoding);
                                var nLines = new List<string>();
                                foreach (var s in lines)
                                {
                                    var regex = Regex.Match(s, "^(\\s+)\"(.*?)\"\\s*?:[^,]*(,+)?.*$");
                                    if (regex.Success)
                                    {
                                        var spaces = regex.Groups[1].Value;
                                        var keyInLine = regex.Groups[2].Value;
                                        var hasComma = regex.Groups[3].Success;

                                        if (keyInLine == keyPart)
                                        {
                                            if (!hasComma)
                                            {
                                                nLines.Add(s + ",");
                                            }
                                            else
                                            {
                                                nLines.Add(s);
                                            }

                                            var l = $"{spaces}\"__comment.cpfa.{user.Login.ToLowerInvariant()}.{keyInLine}\": {comment.ToJsonString(new JsonSerializerOptions {Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping})}{(hasComma ? "," : "")}";
                                            nLines.Add(l);
                                            flag = true;
                                        }
                                        else
                                        {
                                            nLines.Add(s);
                                        }
                                    }
                                    else
                                    {
                                        nLines.Add(s);
                                    }
                                }

                                File.WriteAllLines(filePath, nLines, encoding);
                            }
                        }

                        if (!flag)
                        {
                            throw new CommandException("没有找到对应的 key");
                        }
                        else
                        {
                            r.AddAllFiles();
                            r.Commit($"Add comment", user);
                        }
                    }

                    if (line.StartsWith("/add-mapping "))
                    {
                        if (!await CheckPermission()) continue;
                        var args = line["/add-mapping ".Length..].Split(" ", StringSplitOptions.RemoveEmptyEntries);
                        // if (user.Login != "Cyl18")
                        // {
                        //     sb.AppendLine(Locale.Command_add_mapping_Rejected);
                        //     continue;
                        // }
                        var slug = args[0];
                        var curseForgeProjectID = args[1];
                        ModIDMappingMetadata.Instance.Mapping[slug] = curseForgeProjectID.ToInt();
                        ModIDMappingMetadata.Save();
                        try
                        {
                            var addon = await CurseManager.GetAddon(slug);
                            if (addon.Slug != slug)
                            {
                                sb.AppendLine($"你添加的指定的 curseForgeProjectID 不正确，API 返回 Slug 结果为 {addon.Slug}");
                            }
                            else
                            {
                                sb.AppendLine(string.Format(Locale.Command_add_mapping_Success, slug, curseForgeProjectID));
                            }
                        }
                        catch (Exception e)
                        {
                            sb.AppendLine($"已经保存映射，但是在获取 Addon 时出现了问题：{e}");
                        }
                        
                    }

                    if (line.StartsWith("/diff"))
                    {
                        if (!await CheckPermission()) continue;
                        var exceptionList = new List<Exception>();
                        var list = await LangFileFetcher.FromPR(prid, exceptionList);
                        sb.AppendLine();

                        void AddLine(string sourceEn, string currentEn, StringBuilder stringBuilder, string sourceCn, string currentCn)
                        {
                            if (sourceEn.IsNullOrWhiteSpace())
                            {
                                if (currentEn.IsNullOrWhiteSpace())
                                {
                                    stringBuilder.Append("⛔");
                                }
                                else
                                {
                                    stringBuilder.Append($"{currentEn}");
                                }
                            }
                            else
                            {
                                if (sourceEn.Trim() == currentEn.Trim())
                                {
                                    stringBuilder.Append($"{currentEn}");
                                }
                                else
                                {
                                    stringBuilder.Append($"{sourceEn}<br>🔽<br>{currentEn}");
                                }
                            }

                            stringBuilder.Append(" | ");

                            if (sourceCn.IsNullOrWhiteSpace())
                            {
                                if (currentCn.IsNullOrWhiteSpace())
                                {
                                    stringBuilder.Append("⛔");
                                }
                                else
                                {
                                    stringBuilder.Append($"{currentCn}");
                                }
                            }
                            else
                            {
                                stringBuilder.Append($"{sourceCn}<br>🔽<br>{currentCn}");
                            }
                        }

                        foreach (var o in list)
                        {
                            var diffLines = LangDiffer.Run(o);

                            sb.AppendLine($"<details><summary>{o.ModPath}</summary>\n");
                            sb.AppendLine("| 英文 | 中文 |");
                            sb.AppendLine("| --: | :------------- |");
                            foreach (var (key, sourceEn, currentEn, sourceCn, currentCn) in diffLines)
                            {
                                if (sourceCn == currentCn || currentEn.IsNullOrWhiteSpace() && currentCn.IsNullOrWhiteSpace()) continue;
                                sb.Append("| ");
                                AddLine(sourceEn, currentEn, sb, sourceCn, currentCn);

                                sb.AppendLine(" |");
                            }
                            sb.AppendLine("\n</details>\n\n");


                            sb.AppendLine($"<details><summary>{o.ModPath}-keys</summary>\n");
                            sb.AppendLine("| Key | 英文 | 中文 |");
                            sb.AppendLine("| - | --: | :------------- |");
                            foreach (var (key, sourceEn, currentEn, sourceCn, currentCn) in diffLines)
                            {
                                if (sourceCn == currentCn || currentEn.IsNullOrWhiteSpace() && currentCn.IsNullOrWhiteSpace()) continue;
                                
                                sb.Append("| ");
                                sb.Append($" `{key}` |");
                                AddLine(sourceEn, currentEn, sb, sourceCn, currentCn);

                                sb.AppendLine(" |");
                            }
                            sb.AppendLine("\n</details>\n");


                            sb.AppendLine($"<details><summary>{o.ModPath}-术语检查</summary>\n");
                            sb.AppendLine("| Key | 英文 | 中文 | 检查结果 |");
                            sb.AppendLine("| - | --: | :------------- | - |");
                            foreach (var (key, sourceEn, currentEn, sourceCn, currentCn) in diffLines)
                            {
                                if (sourceCn == currentCn || currentEn.IsNullOrWhiteSpace() && currentCn.IsNullOrWhiteSpace()) continue;

                                string termTextResult = "中文或英文为空";
                                var termResult = currentEn != null && currentCn != null && CheckTerms(currentEn.ToLower(), currentCn.ToLower(), out termTextResult);
                                if (!termResult) continue;
                                
                                sb.Append("| ");
                                sb.Append($" `{key}` |");
                                AddLine(sourceEn, currentEn, sb, sourceCn, currentCn);
                                sb.Append($" | {termTextResult.Replace("\n", "<br>")} | ");
                                sb.AppendLine(" |");
                            }
                            sb.AppendLine("\n</details>\n");

                        }

                        if (exceptionList.Any())
                        {
                            sb.AppendLine($"异常：\n```\n{exceptionList.Select(e => e.ToString()).Connect("\n\n")}\n```");
                        }
                    }

                    if (line.StartsWith("/sort-keys "))
                    {
                        if (!await CheckPermission()) continue;
                        var args = line["/sort-keys ".Length..].Split(" ", StringSplitOptions.RemoveEmptyEntries);
                        var r = GetRepo();
                        var file = args[0];


                        var filePath = Path.Combine(r.WorkingDirectory, file);
                        if (!File.Exists(filePath))
                        {
                            sb.AppendLine(Locale.Command_sort_keys_FileNotExists);
                            continue;
                        }


                        if (file.EndsWith(".json"))
                        {
                            var sourceJson = JsonDocument.Parse(await File.ReadAllTextAsync(filePath), new JsonDocumentOptions() { CommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true });
                            var pairs = sourceJson.RootElement.EnumerateObject()
                                .Select(o => new KeyValuePair<string, string>(o.Name, o.Value.GetString())).OrderBy(pair => pair.Key);
                            var buffer = new MemoryStream();
                            var writer = new Utf8JsonWriter(buffer, new JsonWriterOptions()
                            {
                                Indented = true,
                                Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping
                            });
                            writer.WriteStartObject();
                            foreach (var (key, value) in pairs)
                            {
                                writer.WritePropertyName(key);
                                writer.WriteStringValue(value);
                            }
                            writer.WriteEndObject();
                            await writer.DisposeAsync();
                            buffer.Seek(0, SeekOrigin.Begin);
                            await File.WriteAllTextAsync(filePath, buffer.ToArray().ToUTF8String());

                            r.AddAllFiles();
                            r.Commit($"Reorder file for {(file.Replace("\"", "\\\""))}", user);
                        }
                        else if (file.EndsWith(".lang"))
                        {
                            var lines = (await File.ReadAllLinesAsync(filePath)).Where(l => !(l.StartsWith("#") || l.StartsWith("//") || l.IsNullOrWhiteSpace()));
                            await File.WriteAllLinesAsync(filePath, lines.OrderBy(l => l.Split('=').FirstOrDefault() ?? ""));

                            r.AddAllFiles();
                            r.Commit($"Reorder file for {(file.Replace("\"", "\\\""))}", user);
                        }
                        else
                        {
                            sb.AppendLine(Locale.Command_sort_keys_FileNotRecognized);
                        }

                    }
                }

                if (repo.IsValueCreated)
                {
                    var r = GetRepo();
                    r.Push();
                    //await AddReaction();
                    r.Dispose();
                }
            }
            catch (Exception e)
            {
                sb.AppendLine(string.Format(Locale.Command_general_Error, e.Message));
                Log.Warning(e, $"command processor #{prid}");
            }

            var result = sb.ToString();
            if (result.Length > 65536 / 2)
            {
                try
                {
                    var gist = await GitHub.InstancePersonal.Gist.Create(new NewGist() { Description = $"pr-{prid}-diff", Files = { { $"pr-{prid}-diff.md", result } }, Public = false });
                    result = $"回复内容过长，已经上传至 <{gist.HtmlUrl}>。";
                }
                catch (Exception e)
                {
                    Log.Error(e, "Upload Gist");
                }
            }
            try
            {
                if (!result.IsNullOrWhiteSpace())
                {
                    await GitHub.Instance.Issue.Comment.Create(Constants.Owner, Constants.RepoName, prid, $"@{user.Login} {result}");
                }
            }
            catch (Exception e)
            {
                Log.Error(e, "CommandProcessor CreateComment");
            }
            

            // async Task AddReaction()
            // {
            //     if (addedReaction) return;
            //     addedReaction = true;
            //     await GitHub.Instance.Reaction.CommitComment.Create(Constants.Owner, Constants.RepoName, commentID,
            //         new NewReaction(ReactionType.Rocket));
            // }

            async Task<bool> CheckPermission()
            {
                var bypassList = new string[] { };
                var hasPermission =
                    await GitHub.Instance.Repository.Collaborator.IsCollaborator(Constants.Owner, Constants.RepoName, user.Login) 
                    || bypassList.Contains(user.Login);

                if (!hasPermission && (pr.User.Login == user.Login))
                {
                    // 没有最高权限 但是发送命令的人是 PR 创建者
                    if (pr.Head.Repository.Owner.Login == user.Login)
                    {
                        hasPermission = true;
                    }
                    else
                    {
                        sb.AppendLine(Locale.Command_General_OwnerPermissionDenied);
                        return false;
                    }
                }
                if (!hasPermission)
                {
                    sb.AppendLine(Locale.Command_general_PermissionDenied);
                }
                return hasPermission;
            }

            GitRepoManager GetRepo(bool noDepth = false)
            {
                if (!repo.IsValueCreated)
                {
                    if (pr.Head.Repository.Owner.Login == Constants.Owner && pr.Head.Repository.Name == Constants.RepoName && pr.Head.Ref == "main")
                    {
                        throw new CommandException(Locale.Command_general_MainBranchProtected);
                    }
                    repo.Value.Clone(pr.Head.Repository.Owner.Login, pr.Head.Repository.Name, pr.Head.Ref, noDepth);
                }

                return repo.Value;
            }
        }

        public static bool CheckTerms(string currentEn, string currentCn, out string result)
        {
            var sb = new List<string>();
            foreach (var term in TermManager.Terms)
            {
                if (term.English.Contains(" ") && currentEn.Contains(term.English, StringComparison.Ordinal))
                {
                    if (term.Chineses.Any(termCn => currentCn.Contains(termCn, StringComparison.Ordinal)))
                    {
                        sb.Add($"✔ 术语 {term.English} => {term.Chineses.Connect()}");
                    }
                    else
                    {
                        sb.Add($"⚠ 术语异常 {term.English} => {term.Chineses.Connect()}");
                    }
                }

                foreach (var s in currentEn.Split(new []{ " ", "'" }, StringSplitOptions.None))
                {
                    if (s == term.English)
                    {
                        if (term.Chineses.Any(termCn => currentCn.Contains(termCn, StringComparison.Ordinal)))
                        {
                            sb.Add($"✔ 术语 {term.English} => {term.Chineses.Connect()}");
                        }
                        else
                        {
                            sb.Add($"⚠ 术语异常 {term.English} => {term.Chineses.Connect()}");
                        }
                    }
                }
            }

            if (sb.Any())
            {
                result = sb.Distinct().Connect(Environment.NewLine);
                return true;
            }
            else
            {
                result = null;
                return false;
            }
        }
    }
}
