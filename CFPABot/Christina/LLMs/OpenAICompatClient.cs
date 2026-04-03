#nullable enable
using System;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using Serilog;
using GammaLibrary.Extensions;

namespace CFPABot.Christina.LLMs
{
    /// <summary>
    /// 兼容 OpenAI Chat Completions API 的通用客户端，适用于用户自定义 baseURL 的模型。
    /// 实现 ILLMProvider。
    /// </summary>
    public sealed class OpenAICompatClient : ILLMProvider
    {
        private readonly HttpClient _http;
        private readonly string _baseUrl;
        private readonly string _apiKey;

        private static readonly JsonSerializerOptions JsonOpts = new()
        {
            PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
        };

        public OpenAICompatClient(string baseUrl, string apiKey, HttpClient? http = null)
        {
            _baseUrl = baseUrl.TrimEnd('/');
            _apiKey = apiKey;
            _http = http ?? new HttpClient { Timeout = TimeSpan.FromMinutes(10) };
        }

        public Task<string> QueryAsync(string userPrompt, string model, CancellationToken ct = default)
            => SendAsync(systemPrompt: null, userPrompt, model, ct);

        public Task<string> QueryWithSystemPromptAsync(string systemPrompt, string userPrompt, string model, CancellationToken ct = default)
            => SendAsync(systemPrompt, userPrompt, model, ct);

        public Task<string> QueryWithSystemPromptStructuredAsync(string systemPrompt, string userPrompt, string model, JsonElement responseSchema, CancellationToken ct = default)
            => SendAsync(systemPrompt, userPrompt, model, ct, responseSchema);

        private async Task<string> SendAsync(string? systemPrompt, string userPrompt, string model, CancellationToken ct, JsonElement? responseSchema = null)
        {
            var retryDelays = new[] { 0, 1, 5, 5, 10, 30 };

            for (int attempt = 0; attempt < retryDelays.Length; attempt++)
            {
                if (attempt > 0)
                {
                    Log.Warning("OpenAICompat 重试, model={Model}, attempt={Attempt}", model, attempt);
                    await Task.Delay(TimeSpan.FromSeconds(retryDelays[attempt]), ct);
                }

                using var request = BuildRequest(systemPrompt, userPrompt, model, responseSchema);
                HttpResponseMessage resp;
                string responseBody;

                try
                {
                    resp = await _http.SendAsync(request, ct);
                    responseBody = await resp.Content.ReadAsStringAsync(ct);
                }
                catch (HttpRequestException ex) when (!ct.IsCancellationRequested)
                {
                    Log.Warning(ex, "OpenAICompat 网络错误, model={Model}, attempt={Attempt}", model, attempt);
                    continue;
                }

                Log.Information("OpenAICompat 请求完成, model={Model}, status={Status}", model, (int)resp.StatusCode);

                if (resp.StatusCode == (HttpStatusCode)429)
                {
                    var retryAfter = RetryPolicy.ComputeDelay(resp, attempt);
                    Log.Warning("OpenAICompat 429, 等待 {Delay}s", retryAfter.TotalSeconds);
                    await Task.Delay(retryAfter, ct);
                    continue;
                }

                if (!resp.IsSuccessStatusCode)
                    continue;

                var text = ExtractText(responseBody);
                if (text is not null)
                    return text;
            }

            throw new InvalidOperationException($"OpenAICompat: model={model} all retries exhausted");
        }

        private HttpRequestMessage BuildRequest(string? systemPrompt, string userPrompt, string model, JsonElement? responseSchema = null)
        {
            var messages = systemPrompt is null
                ? new object[] { new { role = "user", content = userPrompt } }
                : new object[] { new { role = "system", content = systemPrompt }, new { role = "user", content = userPrompt } };

            string bodyJson;
            if (responseSchema.HasValue)
            {
                var body = new
                {
                    model,
                    messages,
                    responseFormat = new
                    {
                        type = "json_schema",
                        jsonSchema = new { name = "output", strict = true, schema = responseSchema.Value }
                    }
                };
                bodyJson = body.ToJsonString(JsonOpts);
            }
            else
            {
                bodyJson = new { model, messages }.ToJsonString(JsonOpts);
            }

            var msg = new HttpRequestMessage(HttpMethod.Post, $"{_baseUrl}/chat/completions");
            msg.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _apiKey);
            msg.Content = new StringContent(bodyJson, Encoding.UTF8, "application/json");
            return msg;
        }

        private static string? ExtractText(string responseBody)
        {
            try
            {
                using var doc = JsonDocument.Parse(responseBody);
                var root = doc.RootElement;
                if (root.TryGetProperty("choices", out var choices) && choices.GetArrayLength() > 0)
                {
                    var first = choices[0];
                    if (first.TryGetProperty("message", out var msg) &&
                        msg.TryGetProperty("content", out var content) &&
                        content.ValueKind == JsonValueKind.String)
                    {
                        return content.GetString();
                    }
                }
            }
            catch (JsonException) { }
            return null;
        }
    }
}
