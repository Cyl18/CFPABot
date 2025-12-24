using CFPABot.Exceptions;
using CFPABot.Utils;
using GammaLibrary.Extensions;
using System;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using Serilog;

namespace CFPABot.CFPALLM;
public record PRReviewAssistantData(string Key, long InReplyToId, string ReplyContent);

[Obsolete]
public static class CFPALLMManager
{
    public static async Task<(PRReviewAssistantData[] data, string rawOutput, string indentedjson)> RunPRReview(int prid, string path, string prompt, bool diffMode, IProgress<string> progress)
    {
        throw new NotImplementedException();
        // var delta = "";
        // var openAiClient = new OpenAIClient(clientSettings: new OpenAIClientSettings("https://ark.cn-beijing.volces.com/api", apiVersion: "v3"),
        //     openAIAuthentication: Environment.GetEnvironmentVariable("HUOSHAN_API_KEY"), client: new HttpClient() { Timeout = TimeSpan.FromMinutes(1000) });
        //
        // var response = await openAiClient.ChatEndpoint.StreamCompletionAsync(new ChatRequest(new[]
        // {
        //     new Message(Role.User, prompt + await ProcessPrReviewInput(prid, path, diffMode))
        // }, "deepseek-r1-250120", responseFormat: ChatResponseFormat.Json), chatResponse =>
        // {
        //     var value = chatResponse.FirstChoice?.Delta?.ToString();
        //
        //     if (value != null)
        //     {
        //         delta += value;
        //         progress.Report(delta);
        //     }
        // });
        // var s = response.FirstChoice.Message.ToString();
        // Log.Information($"{prid} 的 LLM 审核结果:");
        // Log.Information(s);
        // var last = s.Split("</think>").Last();
        // var regex = new Regex(@"\[(.|\n)*\]", RegexOptions.Multiline);
        // var rawJson = regex.Match(last).Value;
        // var prReviewAssistantDatas = rawJson.JsonDeserialize<PRReviewAssistantData[]>();
        // ;
        // return (prReviewAssistantDatas, s, prReviewAssistantDatas.ToJsonString(new JsonSerializerOptions()
        //     { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping, }));
    }
    public static async Task<string> ProcessPrReviewInput(int prid, string path, bool diffMode)
    {
        var sb = new StringBuilder();
        var pr = await GitHub.GetPullRequest(prid);
        var enFile = await GetLangFileFromGitHub(pr.Head.Sha, path.Replace("zh_cn", "en_us"));
        string enContent;
        if (path.Contains(".json"))
        {
            if (!LangDataNormalizer.ProcessJsonSingle(enFile, out var ens)) throw new CheckException("Json 语法错误");
            enContent = ens.Select(x => $"{x.Key}={x.Value.Replace("\n", "\\n")}").Connect("\n");
        }
        else
        {
            enContent = LangDataNormalizer.ProcessLangSingle(enFile).Select(x => $"{x.Key}={x.Value.Replace("\n", "\\n")}").Connect("\n");
        }

        if (!diffMode)
        {
            var cnFile = await GetLangFileFromGitHub(pr.Head.Sha, path);
            if (cnFile == null || enFile == null)
            {
                throw new CheckException("找不到对应的文件");
            }

            sb.AppendLine("[英文文件]\n" + enContent);
            sb.AppendLine("[中文文件]\nSTART_OF_FILE\n" + cnFile + "END_OF_FILE");
        }
        else
        {
            var files = await GitHub.Instance.PullRequest.Files(Constants.RepoID, prid);
            var cnDiff = files.First(x => x.FileName == path).Patch;
            sb.AppendLine("[英文文件]\n" + enContent);
            sb.AppendLine("[中文文件Diff]\nSTART_OF_FILE\n" + cnDiff + "END_OF_FILE");


        }
        var prreviewData = await GitHub.GetPRReviewData(prid);

        foreach (var oprr in await GitHub.Instance.PullRequest.ReviewComment.GetAll(Constants.RepoID, prid))
        {
            bool resolved = false;
            foreach (var reviewThreadsEdge in prreviewData.Repository.PullRequest.ReviewThreads.Edges)
            {
                if (reviewThreadsEdge.Node.Comments.Edges.Any(x => x.Node.FullDatabaseId == oprr.Id))
                {
                    if (reviewThreadsEdge.Node.IsResolved)
                    {
                        resolved = true;
                    }
                }       
            }

            sb.AppendLine("[Comment]");
            if (resolved)
            {
                sb.AppendLine("此回复已解决");
            }
            sb.AppendLine($"Id:{oprr.Id}");
            if (oprr.InReplyToId != null)
            {
                sb.AppendLine($"InReplyTo:{oprr.InReplyToId}");
            }

            sb.AppendLine("Content:");
            sb.AppendLine(oprr.Body);
            sb.AppendLine("EndOfContent");
        }

        return sb.ToString();
    }
    // public static async Task<string> ProcessPrReviewInput(int prid, string path)
    // {
    //     var sb = new StringBuilder();
    //     var pr = await GitHub.GetPullRequest(prid);
    //
    //     var cnFile = await GetLangFileFromGitHub(pr.Head.Sha, path);
    //     var enFile = await GetLangFileFromGitHub(pr.Head.Sha, path.Replace("zh_cn", "en_us"));
    //     if (cnFile == null || enFile == null)
    //     {
    //         throw new CheckException("找不到对应的文件");
    //     }
    //
    //     string enContent;
    //     if (path.Contains(".json"))
    //     {
    //         if (!LangDataNormalizer.ProcessJsonSingle(enFile, out var ens)) throw new CheckException("Json 语法错误");
    //         enContent = ens.Select(x => $"{x.Key}={x.Value}").Connect("\n");
    //     }
    //     else
    //     {
    //         enContent = LangDataNormalizer.ProcessLangSingle(enFile).Select(x => $"{x.Key}={x.Value}").Connect("\n");
    //
    //     }
    //
    //     sb.AppendLine("[英文文件]\n"+enContent);
    //     sb.AppendLine("[中文文件]\n" + cnFile);
    //
    //     foreach (var oprr in await GitHub.Instance.PullRequest.ReviewComment.GetAll(Constants.RepoID, prid))
    //     {
    //         sb.AppendLine("[Comment]");
    //         sb.AppendLine($"Id:{oprr.Id}");
    //         if (oprr.InReplyToId != null)
    //         {
    //             sb.AppendLine($"InReplyTo:{oprr.InReplyToId}");
    //         }
    //
    //         sb.AppendLine("Content:");
    //         sb.AppendLine(oprr.Body);
    //         sb.AppendLine("EndOfContent");
    //     }
    //
    //     return sb.ToString();
    // }

    private static HttpClient hc = new HttpClient() {Timeout = TimeSpan.FromMinutes(5)};
    static async Task<string?> GetLangFileFromGitHub(string sha, string path)
    {
        try
        {
            var s = await hc.GetStringAsync(
                $"https://raw.githubusercontent.com/CFPAOrg/Minecraft-Mod-Language-Package/{sha}/{path}");
            return s;
        }
        catch (Exception e)
        {
            return null;
        }
    }
}