using CFPABot.Exceptions;
using CFPABot.Utils;
using GammaLibrary.Extensions;
using OpenAI;
using OpenAI.Chat;
using System;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using Serilog;

namespace CFPABot.CFPALLM;
public record PRReviewAssistantData(string Key, long InReplyToId, string ReplyContent);

public static class CFPALLMManager
{
    public static async Task<(PRReviewAssistantData[] data, string rawOutput)> RunPRReview(int prid, string path, string prompt)
    {
        var openAiClient = new OpenAIClient(clientSettings: new OpenAIClientSettings("https://ark.cn-beijing.volces.com/api", apiVersion: "v3"),
            openAIAuthentication: Environment.GetEnvironmentVariable("HUOSHAN_API_KEY"), client: new HttpClient() { Timeout = TimeSpan.FromMinutes(1000) });
        var response = await openAiClient.ChatEndpoint.GetCompletionAsync(new ChatRequest(new[]
        {
            new Message(Role.User, prompt + await ProcessPrReviewInput(prid, path))
        }, "deepseek-r1-250120", responseFormat: ChatResponseFormat.Json));
        var s = response.FirstChoice.Message.ToString();
        Log.Information($"{prid} 的 LLM 审核结果:");
        Log.Information(s);
        var last = s.Split("</think>").Last();
        var regex = new Regex(@"\[(.|\n)*\]", RegexOptions.Multiline);
        return (regex.Match(last).Value.JsonDeserialize<PRReviewAssistantData[]>(), s);
    }
    public static async Task<string> ProcessPrReviewInput(int prid, string path)
    {
        var sb = new StringBuilder();
        var pr = await GitHub.GetPullRequest(prid);

        var cnFile = await GetLangFileFromGitHub(pr.Head.Sha, path);
        var enFile = await GetLangFileFromGitHub(pr.Head.Sha, path.Replace("zh_cn", "en_us"));
        if (cnFile == null || enFile == null)
        {
            throw new CheckException("找不到对应的文件");
        }

        string enContent;
        if (path.Contains(".json"))
        {
            if (!LangDataNormalizer.ProcessJsonSingle(enFile, out var ens)) throw new CheckException("Json 语法错误");
            enContent = ens.Select(x => $"{x.Key}={x.Value.Replace("\n","\\n")}").Connect("\n");
        }
        else
        {
            enContent = LangDataNormalizer.ProcessLangSingle(enFile).Select(x => $"{x.Key}={x.Value.Replace("\n", "\\n")}").Connect("\n");

        }

        sb.AppendLine("[英文文件]\n" + enContent);
        sb.AppendLine("[中文文件]\nSTART_OF_FILE\n" + cnFile + "END_OF_FILE");
        var prreviewData = await GitHub.GetPRReviewData(prid);

        foreach (var oprr in await GitHub.Instance.PullRequest.ReviewComment.GetAll(Constants.RepoID, prid))
        {
            foreach (var reviewThreadsEdge in prreviewData.Repository.PullRequest.ReviewThreads.Edges)
            {
                if (reviewThreadsEdge.Node.Comments.Edges.Any(x => x.Node.FullDatabaseId == oprr.Id))
                {
                    if (reviewThreadsEdge.Node.IsOutdated || reviewThreadsEdge.Node.IsResolved)
                    {
                        goto end;
                    }
                }       
            }

            sb.AppendLine("[Comment]");
            sb.AppendLine($"Id:{oprr.Id}");
            if (oprr.InReplyToId != null)
            {
                sb.AppendLine($"InReplyTo:{oprr.InReplyToId}");
            }

            sb.AppendLine("Content:");
            sb.AppendLine(oprr.Body);
            sb.AppendLine("EndOfContent");
            end: ;
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