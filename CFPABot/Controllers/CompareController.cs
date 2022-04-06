using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using System.Web;
using CFPABot.Utils;
using DiffPlex.DiffBuilder;
using ForgedCurse.Json;
using GammaLibrary.Extensions;
using Language.Core;
using LibGit2Sharp;
using Octokit;
using Serilog;
using MemoryStream = System.IO.MemoryStream;

namespace CFPABot.Controllers
{
    [Route("[controller]")]
    public class CompareController : ControllerBase
    {
        [HttpGet("PR/{pr}/{modid}/{modDomain}")]
        public IActionResult PR(string pr, string modid, string modDomain)
        {
            return Content($@"
<!DOCTYPE html>
<head>
  <meta name=""robots"" content=""noindex"">
  <meta http-equiv=""refresh"" content=""0; URL=/Compare/PRA/{pr}/{modid}/{modDomain}"" />
</head>
<body>
  <p>正在分析内容，第一次运行需要相当长的时间，一分钟也有可能。你也可以 <a href=""/Compare/PRA/{pr}/{modid}/{modDomain}"">点击这里</a> 来手动跳转。</p>
</body>
        ", "text/html; charset=utf-8");
        }

        [HttpGet("PRA/{pr}/{modid}/{modDomain}")]
        public async Task<IActionResult> PRA(string pr, string modid, string modDomain)
        {
            var sb = new StringBuilder();
            sb.Append($@"
<!DOCTYPE html>
<head>
<meta name=""robots"" content=""noindex"">
<meta name=""viewport"" content=""width=device-width, initial-scale=1"">
<link href=""https://cdn.jsdelivr.net/npm/bootstrap@5.1.3/dist/css/bootstrap.min.css"" rel=""stylesheet"" integrity=""sha384-1BmE4kWBq78iYhFldvKuhfTAU6auU8tT94WrHftjDbrCEXSU1oBoqyl2QvZ6jIW3"" crossorigin=""anonymous"">
</head>
<body>
            ");

            sb.Append(@"
<form method=""post"" action=""/Compare/Do"" enctype=""multipart/form-data"">



");
            var radios = await GenRadios(pr.ToInt(), modid,modDomain);
            sb.Append(@"<div class=""row"">");
            sb.Append(@"<div class=""col"" ><fieldset class=""form-group"" id=""comparea"" style=""margin: 24px;"">");
            sb.Append(radios.Replace("%NAME%", "comparea"));
            sb.Append(@"</fieldset>
</div>");
            sb.Append(@"<div class=""col"" >");
            sb.Append(@"<fieldset class=""form-group"" id=""compareb"" style=""margin: 24px;"">");
            sb.Append(radios.Replace("%NAME%", "compareb"));
            sb.Append(@"</fieldset>

</div></div>");

            sb.Append(@$"
<button type=""submit"" class=""btn btn-primary"">Submit</button>
<input hidden name=""pr"" value=""{pr}""/>
<input hidden name=""modid"" value=""{modid}""/>
<input hidden name=""moddomain"" value=""{modDomain}""/>
</form>
");
            sb.Append(@"");
            sb.Append(@"");
            sb.Append(@"");
            sb.Append(@"");
            sb.Append(@"");

            sb.Append(@"
<script src=""https://cdn.jsdelivr.net/npm/bootstrap@5.1.3/dist/js/bootstrap.bundle.min.js"" integrity=""sha384-ka7Sk0Gln4gmtz2MlQnikT1wXgYsOg+OMhuP+IlRH9sENBO0LRn5q+8nbTov4+1p"" crossorigin=""anonymous""></script>
</body>
        ");
            return Content(sb.ToString(), "text/html; charset=utf-8");
        }

        static HttpClient hc = new HttpClient();
        async Task<bool> LinkExists(string link)
        {
            try
            {
                var message = await hc.GetAsync(link);
                message.EnsureSuccessStatusCode();
                return true;
            }
            catch (Exception e)
            {
                return false;
            }
        }
        async Task<string> GenRadios(int prid, string modid, string modDomain)
        {
            var sb = new StringBuilder();
            var pr = await GitHub.GetPullRequest(prid);
            var headSha = pr.Head.Sha;

            var diffs = await GitHub.Diff(prid);
            int id = 0;

            try
            {
                foreach (var diff in diffs)
                {
                    var names = diff.To.Split('/');
                    if (names.Length < 7) continue; // 超级硬编码
                    if (names[0] != "projects") continue;
                    if (names[5] != "lang") continue;

                    var versionString = names[1];
                    var curseID = names[3];
                    var check = (versionString, curseID);
                    var mcVersion = versionString.ToMCVersion();
                    if (curseID != modid) continue;
                    AddRadio($"<a href=\"https://github.com/CFPAOrg/Minecraft-Mod-Language-Package/blob/{headSha}/{diff.To}\">PR 所改动的</a> {versionString}/{curseID}/{modDomain}/{names[6]}", $"link`https://raw.githubusercontent.com/CFPAOrg/Minecraft-Mod-Language-Package/{headSha}/{diff.To}");
                }
            }
            catch (Exception e)
            {
                Log.Information(e, "PR");
            }


            var tasks = new List<Task>();
            foreach (var versionName in Enum.GetValues<MCVersion>().Select(e => e.ToVersionString()))
            {
                foreach (var s in versionName == "1.12.2" ? new [] {"zh_cn.lang", "zh_CN.lang", "en_us.lang", "en_US.lang"} : new [] {"zh_cn.json", "zh_CN.json", "en_us.json", "en_US.json"})
                {
                    var link =
                        $"https://raw.githubusercontent.com/CFPAOrg/Minecraft-Mod-Language-Package/main/projects/{versionName}/assets/{modid}/{modDomain}/lang/{s}";
                    
                    tasks.Add(R(link));
                    async Task R(string l)
                    {
                        if (await LinkExists(l))
                        {
                            AddRadio($"<a href=\"https://github.com/CFPAOrg/Minecraft-Mod-Language-Package/blob/main/projects/{versionName}/assets/{modid}/{modDomain}/lang/{s}\">仓库中的</a> {versionName}/{modid}/{modDomain}/{s}", $"link`{l}");
                        }
                    }
                }
            }

            await Task.WhenAll(tasks);

            Addon addon = null;
            try
            {
                addon = await CurseManager.GetAddon(modid);
            }
            catch (Exception e)
            {
                Log.Information(e, "Addon");
            }
            // add mod file
            if (addon != null)
            {
                try
                {
                    var checkedSet = new HashSet<int>();
                    foreach (var file in addon.Files)
                    {
                        if (checkedSet.Contains(file.FileId)) continue;
                        checkedSet.Add(file.FileId);
                        try
                        {
                            var downloadUrl = CurseManager.GetDownloadUrl(file);
                            var enr = (await CurseManager.GetModLangFiles(downloadUrl, LangType.EN));
                            var enfiles = enr.Item2.ToArray();
                            foreach (var entry in enfiles)
                            {
                                AddRadio($"<a href=\"{downloadUrl}\">模组 {file.FileType switch { 2 => "🅱 ", 3 => "🅰 ", 1 => "" }}{file.GameVersion}-{file.FileName}</a> 中的英文语言文件 {(enfiles.Length > 1 ? entry.FullName : "")}", $"mod`{downloadUrl}`{entry.FullName}");
                            }

                            var cnr = (await CurseManager.GetModLangFiles(downloadUrl, LangType.CN));
                            var cnfiles = cnr.Item2.ToArray();
                            foreach (var entry in cnfiles)
                            {
                                AddRadio($"<a href=\"{downloadUrl}\">模组 {file.FileType switch { 2 => "🅱 ", 3 => "🅰 ", 1 => "" }}{file.GameVersion}-{file.FileName}</a> 中的中文语言文件 {(cnfiles.Length > 1 ? entry.FullName : "")}", $"mod`{downloadUrl}`{entry.FullName}");
                            }
                            //AddRadio($"模组 {file.FileType switch { 2 => "🅱 ", 3 => "🅰 ", 1 => "" }}{file.GameVersion}-{file.FileName} 中的中文语言文件", $"mod:{CurseManager.GetDownloadUrl(file)}:en");
                            enr.Item1.Close();
                            cnr.Item1.Close();
                        }
                        catch (Exception e)
                        {
                            Console.WriteLine(e);
                        }
                    }
                }
                catch (Exception e)
                {
                    Log.Information(e, "Mod File");
                }
            }


            if (addon != null)
            try
            {
                var s = JsonDocument.Parse(await Download.String($"https://addons-ecs.forgesvc.net/api/v2/addon/{addon.Identifier}/"));
                var url = s.RootElement.GetProperty("sourceUrl").GetString().TrimEnd('/');
                var analyzeResult = await RepoAnalyzer.Analyze(url);
                foreach (var (branch, filePath, fileName, langType, commitSha) in analyzeResult.Results)
                {
                    AddRadio($"模组源代码<a href=\"https://github.com/{analyzeResult.Owner}/{analyzeResult.RepoName}\">仓库</a>中 {branch} 分支的 <a href=\"https://github.com/{analyzeResult.Owner}/{analyzeResult.RepoName}/blob/{commitSha}/{filePath}\">{filePath}</a>", $"link`" +
                        $"https://raw.githubusercontent.com/{analyzeResult.Owner}/{analyzeResult.RepoName}/{commitSha}/{filePath}");
                }
            }
            catch (Exception e)
            {
                //Log.Information(e, "Mod Repo");
            }

            AddFile();

            var i2 = id++;

            sb.AppendLine($@"
<div class=""form-check"">
  <input type=""checkbox"" id=""%NAME%customCheck{i2}"" name=""cn%NAME%"" value=""true"" class=""form-check-input"" />
  <label class=""custom-control-label"" for=""%NAME%customCheck{i2}"" >勾选：使用上传模组的中文语言文件 不勾选：使用上传模组的英文语言文件</label>
</div>
");
            var i1 = id++;
            sb.AppendLine($@"
<div class=""form-check"">
  <input type=""checkbox"" id=""%NAME%customCheck{i1}"" name=""format%NAME%"" value=""true"" class=""form-check-input"" checked />
  <label class=""custom-control-label"" for=""%NAME%customCheck{i1}"" >格式化文本</label>
</div>
");
            return sb.ToString();



            void AddRadio(string text, string value)
            {
                lock (this)
                {
                    var i = id++;
                    sb.AppendLine($@"
<div class=""form-check"" style=""margin: 6px;"">
  <input type=""radio"" id=""%NAME%customRadio{i}"" name=""%NAME%"" value=""{HttpUtility.HtmlEncode(value)}"" class=""form-check-input"">
  <label class=""form-check-label"" for=""%NAME%customRadio{i}"" style=""{(text.Contains("zh_") || text.Contains("中文") ? "color: #0077c2" : text.Contains("en_") || text.Contains("英文") ? "color: #b61827" : "")} "">{text}</label>
</div>");
                }
                
            }

            void AddFile()
            {
                var i = id++;
                sb.AppendLine($@"
<div class=""form-check"" style=""margin: 6px;"">
  <input type=""radio"" id=""%NAME%customRadio{i}"" name=""%NAME%"" value=""file`"" class=""form-check-input"">
  <label class=""form-check-label"" for=""%NAME%customRadio{i}"" style="" "">语言文件/模组</label>
  <input type=""file""
       id=""file%NAME%"" name=""file%NAME%"">
</div>");
            }
        }

        [HttpPost("Do")]
        public async Task<IActionResult> RunCheck(string comparea, string compareb, string checka, string checkb)
        {
            var f1 = (await GetFile(comparea, HttpContext.Request.Form.Files.FirstOrDefault(f => f.Name == "filecomparea"), HttpContext.Request.Form["cncomparea"].FirstOrDefault() == "true")).Replace("\r\n", "\n").TrimStart('\uFEFF');
            var f2 = (await GetFile(compareb, HttpContext.Request.Form.Files.FirstOrDefault(f => f.Name == "filecompareb"), HttpContext.Request.Form["cncompareb"].FirstOrDefault() == "true")).Replace("\r\n", "\n").TrimStart('\uFEFF');

            if (HttpContext.Request.Form["formatcomparea"].FirstOrDefault() == "true")
            {
                var s1 = new MemoryStream(f1.ToUTF8Bytes());
                var s2 = new MemoryStream();
                
                var reader = s1.CreateStreamReader();
                var writer = s2.CreateStreamWriter();
                // todo 这里需要改
                // todo 还需要加入某个地方json的注释跳过
                if (f1.TrimStart().StartsWith("{"))
                {
                    new JsonFormatter(reader, writer).Format();
                }
                else
                {
                    new LangFormatter(reader, writer).Format();
                }

                f1 = s2.ToArray().ToUTF8String().TrimStart('\uFEFF');
            }

            if (HttpContext.Request.Form["formatcompareb"].FirstOrDefault() == "true")
            {
                var s1 = new MemoryStream(f2.ToUTF8Bytes());
                var s2 = new MemoryStream();

                var reader = s1.CreateStreamReader();
                var writer = s2.CreateStreamWriter();
                if (f2.TrimStart().StartsWith("{"))
                {
                    new JsonFormatter(reader, writer).Format();
                }
                else
                {
                    new LangFormatter(reader, writer).Format();
                }

                f2 = s2.ToArray().ToUTF8String().TrimStart('\uFEFF');
            }
            
            var f1h = f1.SHA256().ToHexString()[..6];
            var f2h = f2.SHA256().ToHexString()[..6];
            if (f1 == f2) return Content("文件内容完全相同。");
            
            var filename = $"{f1h}-{f2h}.html";
            var link = $"/static/{filename}";
            var filePath = $"wwwroot/{filename}";
            if (System.IO.File.Exists(filename)) return Redirect(link);

            var f1p = Path.GetTempFileName();
            var f2p = Path.GetTempFileName();
            var diffp = Path.GetTempFileName();
            System.IO.File.WriteAllText(f1p, f1, Encoding.UTF8);
            System.IO.File.WriteAllText(f2p, f2, Encoding.UTF8);

            var proc = new Process
            {
                StartInfo = new ProcessStartInfo
                {
                    FileName = "/bin/bash",
                    Arguments = "-c \"" + $"git diff --no-index {f1p} {f2p} > {diffp}" + "\"",
                    UseShellExecute = false,
                }
            };

            proc.Start();
            await proc.WaitForExitAsync();
            

            await System.IO.File.WriteAllTextAsync(filePath, 
                $@"
<!DOCTYPE html>
<html lang=""en-us"">
  <head>
    <meta charset=""utf-8"" />
    <meta name=""robots"" content=""noindex"">
    <!-- Make sure to load the highlight.js CSS file before the Diff2Html CSS file -->
    <link rel=""stylesheet"" href=""https://cdnjs.cloudflare.com/ajax/libs/highlight.js/10.7.1/styles/github.min.css"" />
    <link
      rel=""stylesheet""
      type=""text/css""
      href=""https://cdn.jsdelivr.net/npm/diff2html/bundles/css/diff2html.min.css""
    />
    <script type=""text/javascript"" src=""https://cdn.jsdelivr.net/npm/diff2html/bundles/js/diff2html-ui.min.js""></script>
  </head>
  <script>
    const diffString = `{System.IO.File.ReadAllText(diffp).Replace("\\","\\\\").Replace("`", "\\`")}`;

    function r(a) {{
      var targetElement = document.getElementById('myDiffElement');
      var configuration = {{
        drawFileList: true,
        fileListToggle: false,
        fileListStartVisible: false,
        fileContentToggle: false,
        matching: 'lines',
        outputFormat: a ? 'side-by-side' : 'line-by-line',
        synchronisedScroll: true,
        highlight: true,
        renderNothingWhenEmpty: false,
      }};
      var diff2htmlUi = new Diff2HtmlUI(targetElement, diffString, configuration);
      diff2htmlUi.draw();
      diff2htmlUi.highlightCode();
    }}
    document.addEventListener('DOMContentLoaded', function () {{ r(true); }});
function download(filename, text) {{
  var element = document.createElement('a');
  element.setAttribute('href', 'data:text/plain;charset=utf-8,' + encodeURIComponent(text));
  element.setAttribute('download', filename);

  element.style.display = 'none';
  document.body.appendChild(element);

  element.click();

  document.body.removeChild(element);
}}

  </script>
  <body>
<label>Chrome显示有些问题，建议用FireFox</label>
    <button onclick=""r(false);"">切换行显示模式</button>
    <button onclick=""download('{f1h}-{f2h}.diff', diffString);"">下载 .diff 文件</button>
    <div id=""myDiffElement""></div>
  </body>
</html>
");
            try
            {
                System.IO.File.Delete(f1p);
                System.IO.File.Delete(f2p);
                System.IO.File.Delete(diffp);
            }
            catch (Exception e)
            {
            }
            return Redirect(link);

            async Task<string> GetFile(string compare, IFormFile file, bool cn)
            {
                var s = compare.Split("`");
                switch (s[0])
                {
                    case "link":
                        return await Download.String(s[1]);
                        
                    case "file":
                        if (file.FileName.EndsWith(".jar"))
                        {
                            var fc1 = file.OpenReadStream();
                            var path = Path.GetTempFileName();
                            var wfs = System.IO.File.OpenWrite(path);
                            await fc1.CopyToAsync(wfs);
                            wfs.Close();

                            var fs1 = FileUtils.OpenFile(path);
                            try
                            {
                                var f = CurseManager.GetModLangFilesFromStream(fs1, cn ? LangType.CN : LangType.EN);
                                return await f.First().Open().ReadToEndAsync1();
                            }
                            finally
                            {
                                fs1.Close();
                                System.IO.File.Delete(path);
                            } 
                        }
                        var fc = await file.OpenReadStream().ReadToEndAsync1(Encoding.UTF8);
                        return fc;
                    case "mod":
                    {
                        var f = await Download.DownloadFile(s[1]);
                        await using var fs = FileUtils.OpenFile(f);
                        var zip = new ZipArchive(fs);
                        return await zip.GetEntry(s[2]).Open().ReadToEndAsync1();
                    }
                }

                return null;
            }

        }
    }
}
