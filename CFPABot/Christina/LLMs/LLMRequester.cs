#nullable enable
using System;
using CFPABot.Utils;
using GammaLibrary.Extensions;

/*
  var keys = new ApiKeyPool(new[]
   {
       "key1",
       "key2",
       "key3"
   });
   
   var tools = new ToolRegistry();
   tools.Register("add", args => "{ \"result\": 3 }");
   
   var client = new OpenRouterClient(keys);
   
   var request = new ResponseRequest
   {
       Input = new List<object>
       {
           new {
               type = "message",
               role = "user",
               content = "call tool add"
           }
       },
       Tools = new[]
       {
           new {
               type = "function",
               name = "add",
               parameters = new {
                   type = "object"
               }
           }
       }
   };
   
   var result = await client.RunAsync(
       request,
       tools,
       new ModelPolicy(
           "anthropic/claude-4.5-sonnet",
           "openai/gpt-4.1"
       )
   );
   
 */
namespace CFPABot.Christina.LLMs
{
    using System;
    using System.Collections.Generic;
    using System.Linq;
    using System.Net;
    using System.Net.Http;
    using System.Text;
    using System.Text.Json;
    using System.Text.Json.Serialization;
    using System.Threading;
    using System.Threading.Tasks;
    using Serilog;

    public sealed class OpenRouterClient
    {
        private const int MaxGlobalConcurrentRequests = 15;
        private static readonly SemaphoreSlim GlobalRequestGate = new(MaxGlobalConcurrentRequests, MaxGlobalConcurrentRequests);
        private static readonly JsonSerializerOptions StructuredChatJson = new()
        {
            PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
        };
        private readonly HttpClient _http;
        private readonly ApiKeyPool _keyPool;
        private readonly JsonSerializerOptions _json;

        private const string Endpoint = "https://openrouter.ai/api/v1/responses";
        private const string ChatCompletionsEndpoint = "https://openrouter.ai/api/v1/chat/completions";

        public OpenRouterClient()
        {
            _keyPool = new ApiKeyPool(new []{Constants.OpenRouterApiKey, Constants.OpenRouterApiKey2 });
            _http = new HttpClient { Timeout = TimeSpan.FromMinutes(10) };
            _json = new JsonSerializerOptions
            {
                PropertyNamingPolicy = JsonNamingPolicy.CamelCase
            };
        }

        public OpenRouterClient(ApiKeyPool keyPool, HttpClient? http = null)
        {
            _keyPool = keyPool;
            _http = http ?? new HttpClient { Timeout = TimeSpan.FromMinutes(10) };
            _json = new JsonSerializerOptions
            {
                PropertyNamingPolicy = JsonNamingPolicy.CamelCase
            };
        }

        public async Task<ResponseEnvelope> RunAsync(
            ResponseRequest request,
            ToolRegistry tools,
            ModelPolicy modelPolicy,
            CancellationToken ct = default)
        {
            var session = LlmDebugLogger.StartSession("openrouter-run");
            var context = new List<object>(request.Input);
            int sendIndex = 0;

            foreach (var model in modelPolicy.Enumerate())
            {
                request.Model = model;

                while (true)
                {
                    var apiKey = await _keyPool.Acquire();
                    using var msg = BuildHttpRequest(apiKey, request, context);

                    Log.Information("OpenRouter RunAsync 发送请求, model={Model}, sendIndex={SendIndex}", model, ++sendIndex);
                    var resp = await SendWith429Retry(msg, apiKey, ct);

                    var responseBody = await resp.Content.ReadAsStringAsync();
                    bool success = resp.IsSuccessStatusCode;
                    var contextSnapshot = context.ToList();
                    await session.WriteAsync(new
                    {
                        timestamp = DateTime.UtcNow,
                        client = "openrouter",
                        method = "run",
                        model,
                        sendIndex,
                        success,
                        statusCode = (int)resp.StatusCode,
                        prompt = new { input = contextSnapshot, tools = request.Tools },
                        response = responseBody
                    });

                    if (!success)
                        break;

var payload = responseBody.JsonDeserialize<ResponseEnvelope>(_json)
                                  ?? throw new InvalidOperationException("Invalid response");
                    var toolCalls = payload.ExtractToolCalls();

                    if (toolCalls.Count == 0)
                        return payload;

                    foreach (var call in toolCalls)
                    {
                        var output = tools.Invoke(call.Name, call.Arguments);
                        context.Add(ToolItems.FunctionOutput(call.CallId, output));
                    }
                }
            }

            throw new InvalidOperationException("All models exhausted");
        }

        private HttpRequestMessage BuildHttpRequest(
            string apiKey,
            ResponseRequest req,
            List<object> context)
        {
            var body = new
            {
                model = req.Model,
                input = context,
                tools = req.Tools
            };

            var msg = new HttpRequestMessage(HttpMethod.Post, Endpoint);
            msg.Headers.Authorization =
                new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", apiKey);
            msg.Content = new StringContent(
                body.ToJsonString(_json),
                Encoding.UTF8,
                "application/json");

            return msg;
        }

        private async Task<HttpResponseMessage> SendWith429Retry(
            HttpRequestMessage msg,
            string apiKey,
            CancellationToken ct)
        {
            const int maxRetries = 6;
            var attempt = 0;

            while (true)
            {
                var clone = await CloneRequestAsync(msg);
                var resp = await SendAsyncWithGlobalLimit(clone, ct);

                if (resp.StatusCode != (HttpStatusCode)429 || attempt >= maxRetries)
                    return resp;

                _keyPool.Penalize(apiKey);

                attempt++;
                var delay = RetryPolicy.ComputeDelay(resp, attempt);
                Log.Warning("OpenRouter 429 被限流，{Delay}s 后重试 (attempt {Attempt}/{MaxRetries})", delay.TotalSeconds, attempt, maxRetries);
                await Task.Delay(delay, ct);
            }
        }

        private async Task<ResponseEnvelope> ParseAsync(HttpResponseMessage resp)
        {
            var json = await resp.Content.ReadAsStringAsync();
            return json.JsonDeserialize<ResponseEnvelope>(_json)
                   ?? throw new InvalidOperationException("Invalid response");
        }

        private async Task<HttpResponseMessage> SendAsyncWithGlobalLimit(HttpRequestMessage request, CancellationToken ct)
        {
            await GlobalRequestGate.WaitAsync(ct);
            try
            {
                return await _http.SendAsync(request, ct);
            }
            finally
            {
                GlobalRequestGate.Release();
            }
        }

        private static async Task<HttpRequestMessage> CloneRequestAsync(HttpRequestMessage original)
        {
            var clone = new HttpRequestMessage(original.Method, original.RequestUri);
            foreach (var header in original.Headers)
                clone.Headers.TryAddWithoutValidation(header.Key, header.Value);

            if (original.Content is not null)
            {
                var body = await original.Content.ReadAsByteArrayAsync();
                clone.Content = new ByteArrayContent(body);
                foreach (var header in original.Content.Headers)
                    clone.Content.Headers.TryAddWithoutValidation(header.Key, header.Value);
            }

            return clone;
        }

        private HttpRequestMessage BuildStructuredChatRequest(
            string apiKey,
            string systemPrompt,
            string userPrompt,
            string model,
            JsonElement responseSchema)
        {
            var messages = systemPrompt is null
                ? new object[] { new { role = "user", content = userPrompt } }
                : new object[] { new { role = "system", content = systemPrompt }, new { role = "user", content = userPrompt } };

            var body = new
            {
                model,
                messages,
                responseFormat = new
                {
                    type = "json_schema",
                    jsonSchema = new { name = "output", strict = true, schema = responseSchema }
                }
            };

            var msg = new HttpRequestMessage(HttpMethod.Post, ChatCompletionsEndpoint);
            msg.Headers.Authorization =
                new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", apiKey);
            msg.Content = new StringContent(
                body.ToJsonString(StructuredChatJson),
                Encoding.UTF8,
                "application/json");
            return msg;
        }

        private static string? ExtractChatCompletionText(string responseBody)
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

        /// <summary>单次请求，不使用工具，直接返回模型的文本回复。</summary>
        public async Task<string> QueryAsync(
            string userPrompt,
            ModelPolicy modelPolicy,
            CancellationToken ct = default)
        {
            var session = LlmDebugLogger.StartSession("openrouter-query");
            int attempt = 0;

            foreach (var model in modelPolicy.Enumerate())
            {
                attempt++;
                var apiKey = await _keyPool.Acquire();
                var body = new
                {
                    model,
                    input = new[]
                    {
                        new { type = "message", role = "user", content = userPrompt }
                    }
                };

                Log.Information("OpenRouter QueryAsync 发送请求, model={Model}, attempt={Attempt}", model, attempt);
                using var msg = new HttpRequestMessage(HttpMethod.Post, Endpoint);
                msg.Headers.Authorization =
                    new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", apiKey);
                msg.Content = new StringContent(
                    body.ToJsonString(_json),
                    Encoding.UTF8,
                    "application/json");

                string responseBody;
                bool requestSucceeded;
                int statusCode;
                try
                {
                    var resp = await SendAsyncWithGlobalLimit(msg, ct);
                    responseBody = await resp.Content.ReadAsStringAsync();
                    requestSucceeded = resp.IsSuccessStatusCode;
                    statusCode = (int)resp.StatusCode;
                }
                catch (HttpRequestException ex) when (!ct.IsCancellationRequested)
                {
                    Log.Warning(ex, "OpenRouter QueryAsync 网络错误, model={Model}, attempt={Attempt}, 继续重试", model, attempt);
                    continue;
                }

                await session.WriteAsync(new
                {
                    timestamp = DateTime.UtcNow,
                    client = "openrouter",
                    method = "query",
                    model,
                    attempt,
                    success = requestSucceeded,
                    statusCode,
                    prompt = new { user = userPrompt },
                    response = responseBody
                });

                if (!requestSucceeded)
                    continue;

                var payload = responseBody.JsonDeserialize<ResponseEnvelope>(_json)
                              ?? throw new InvalidOperationException("Invalid response");
                var text = payload.GetText();
                if (text is not null)
                    return text;
            }

            throw new InvalidOperationException("All models exhausted");
        }

        /// <summary>单次请求，带 system prompt，不使用工具，直接返回模型的文本回复。</summary>
        public async Task<string> QueryWithSystemPromptAsync(
            string systemPrompt,
            string userPrompt,
            ModelPolicy modelPolicy,
            CancellationToken ct = default)
        {
            var session = LlmDebugLogger.StartSession("openrouter-query-sys");
            int attempt = 0;

            foreach (var model in modelPolicy.Enumerate())
            {
                attempt++;
                var apiKey = await _keyPool.Acquire();
                var body = new
                {
                    model,
                    input = new object[]
                    {
                        new { type = "message", role = "system", content = systemPrompt },
                        new { type = "message", role = "user",   content = userPrompt }
                    }
                };

                Log.Information("OpenRouter QueryWithSystemPromptAsync 发送请求, model={Model}, attempt={Attempt}", model, attempt);
                using var msg = new HttpRequestMessage(HttpMethod.Post, Endpoint);
                msg.Headers.Authorization =
                    new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", apiKey);
                msg.Content = new StringContent(
                    body.ToJsonString(_json),
                    Encoding.UTF8,
                    "application/json");

                string responseBody;
                bool requestSucceeded;
                int statusCode;
                try
                {
                    var resp = await SendAsyncWithGlobalLimit(msg, ct);
                    responseBody = await resp.Content.ReadAsStringAsync();
                    requestSucceeded = resp.IsSuccessStatusCode;
                    statusCode = (int)resp.StatusCode;
                }
                catch (HttpRequestException ex) when (!ct.IsCancellationRequested)
                {
                    Log.Warning(ex, "OpenRouter QueryWithSystemPromptAsync 网络错误, model={Model}, attempt={Attempt}, 继续重试", model, attempt);
                    continue;
                }

                await session.WriteAsync(new
                {
                    timestamp = DateTime.UtcNow,
                    client = "openrouter",
                    method = "query-with-system",
                    model,
                    attempt,
                    success = requestSucceeded,
                    statusCode,
                    prompt = new { system = systemPrompt, user = userPrompt },
                    response = responseBody
                });

                if (!requestSucceeded)
                    continue;

                var payload = responseBody.JsonDeserialize<ResponseEnvelope>(_json)
                              ?? throw new InvalidOperationException("Invalid response");
                var text = payload.GetText();
                if (text is not null)
                    return text;
            }

            throw new InvalidOperationException("All models exhausted");
        }

        public async Task<string> QueryWithSystemPromptStructuredAsync(
            string systemPrompt,
            string userPrompt,
            ModelPolicy modelPolicy,
            JsonElement responseSchema,
            CancellationToken ct = default)
        {
            var session = LlmDebugLogger.StartSession("openrouter-query-structured");
            var retryDelays = new[] { 0, 1, 5, 5, 10, 30 };

            foreach (var model in modelPolicy.Enumerate())
            {
                for (int attempt = 0; attempt < retryDelays.Length; attempt++)
                {
                    if (attempt > 0)
                    {
                        Log.Warning("OpenRouter QueryWithSystemPromptStructuredAsync 重试, model={Model}, attempt={Attempt}", model, attempt);
                        await Task.Delay(TimeSpan.FromSeconds(retryDelays[attempt]), ct);
                    }

                    var apiKey = await _keyPool.Acquire();
                    using var msg = BuildStructuredChatRequest(apiKey, systemPrompt, userPrompt, model, responseSchema);

                    string responseBody;
                    bool requestSucceeded;
                    int statusCode;
                    HttpResponseMessage resp;
                    try
                    {
                        resp = await SendAsyncWithGlobalLimit(msg, ct);
                        responseBody = await resp.Content.ReadAsStringAsync(ct);
                        requestSucceeded = resp.IsSuccessStatusCode;
                        statusCode = (int)resp.StatusCode;
                    }
                    catch (HttpRequestException ex) when (!ct.IsCancellationRequested)
                    {
                        Log.Warning(ex, "OpenRouter QueryWithSystemPromptStructuredAsync 网络错误, model={Model}, attempt={Attempt}", model, attempt);
                        continue;
                    }

                    await session.WriteAsync(new
                    {
                        timestamp = DateTime.UtcNow,
                        client = "openrouter",
                        method = "query-structured",
                        model,
                        attempt,
                        success = requestSucceeded,
                        statusCode,
                        prompt = new { system = systemPrompt, user = userPrompt, schema = responseSchema },
                        response = responseBody
                    });

                    if (resp.StatusCode == (HttpStatusCode)429)
                    {
                        _keyPool.Penalize(apiKey);
                        var retryAfter = RetryPolicy.ComputeDelay(resp, attempt + 1);
                        Log.Warning("OpenRouter structured 429, 等待 {Delay}s", retryAfter.TotalSeconds);
                        await Task.Delay(retryAfter, ct);
                        continue;
                    }

                    if (!requestSucceeded)
                        continue;

                    var text = ExtractChatCompletionText(responseBody);
                    if (text is not null)
                        return text;
                }
            }

            throw new InvalidOperationException("All models exhausted");
        }
    }

    public sealed class ApiKeyPool
    {
        private readonly string[] _keys;

        public ApiKeyPool(IEnumerable<string> keys)
        {
            _keys = keys.ToArray();
        }

        public Task<string> Acquire()
        {
            if (_keys.Length == 0)
                throw new InvalidOperationException("No API key available");
            return Task.FromResult(_keys[Random.Shared.Next(_keys.Length)]);
        }

        public void Penalize(string key)
        {
            // No-op: cooldown removed, retry delay is handled by the caller
        }
    }

    public sealed class ModelPolicy
    {
        private readonly List<string> _models;

        public ModelPolicy(params string[] models)
        {
            _models = new List<string>(models);
        }

        public IEnumerable<string> Enumerate() => _models;
    }

    public static class RetryPolicy
    {
        public static TimeSpan ComputeDelay(HttpResponseMessage resp, int attempt)
        {
            if (resp.Headers.TryGetValues("Retry-After", out var v) &&
                int.TryParse(v.FirstOrDefault(), out var seconds))
            {
                return TimeSpan.FromSeconds(seconds);
            }

            return TimeSpan.FromSeconds(Math.Min(30, Math.Pow(2, attempt)));
        }
    }


    public sealed class ResponseEnvelope
    {
        public List<ResponseOutputItem> Output { get; set; } = new();

        public string? GetText() =>
            Output
                .FirstOrDefault(o => o.Type == "message")
                ?.Content?.FirstOrDefault(c => c.Type == "output_text")
                ?.Text;

        public List<FunctionCall> ExtractToolCalls()
        {
            var list = new List<FunctionCall>();

            foreach (var item in Output)
            {
                if (item.Type == "function_call")
                {
                    list.Add(new FunctionCall
                    {
                        Name = item.Name!,
                        Arguments = item.Arguments!,
                        CallId = item.CallId!
                    });
                }
            }

            return list;
        }
    }

    public sealed class ResponseOutputItem
    {
        public string Type { get; set; } = "";
        public string? Name { get; set; }
        public string? Arguments { get; set; }
        public string? CallId { get; set; }
        public List<ResponseContentItem>? Content { get; set; }
    }

    public sealed class ResponseContentItem
    {
        public string Type { get; set; } = "";
        public string? Text { get; set; }
    }

    public sealed class FunctionCall
    {
        public string Name = "";
        public string Arguments = "";
        public string CallId = "";
    }

    public sealed record ResponseRequest
    {
        /// <summary>
        /// 当前实际使用的模型，由 ModelPolicy 在外部写入
        /// </summary>
        public string Model { get; set; } = "";

        /// <summary>
        /// OpenRouter Responses API 的 input
        /// 直接使用 object，避免过度 DTO 化
        /// </summary>
        public List<object> Input { get; set; } = new();

        /// <summary>
        /// function / web_search 等工具定义
        /// </summary>
        public object[]? Tools { get; set; }

        public bool? ParallelToolCalls { get; set; }

        public double? Temperature { get; set; }

        public double? TopP { get; set; }

        public int? MaxOutputTokens { get; set; }
    }

    /// <summary>将 OpenRouterClient 适配为 ILLMProvider。</summary>
    public sealed class OpenRouterProviderAdapter : ILLMProvider
    {
        private readonly OpenRouterClient _client;

        public OpenRouterProviderAdapter(ApiKeyPool keyPool, HttpClient? http = null)
        {
            _client = new OpenRouterClient(keyPool, http);
        }

        public Task<string> QueryAsync(string userPrompt, string model, CancellationToken ct = default)
            => _client.QueryAsync(userPrompt, new ModelPolicy(model), ct);

        public Task<string> QueryWithSystemPromptAsync(string systemPrompt, string userPrompt, string model, CancellationToken ct = default)
            => _client.QueryWithSystemPromptAsync(systemPrompt, userPrompt, new ModelPolicy(model), ct);

        public Task<string> QueryWithSystemPromptStructuredAsync(string systemPrompt, string userPrompt, string model, System.Text.Json.JsonElement responseSchema, CancellationToken ct = default)
            => _client.QueryWithSystemPromptStructuredAsync(systemPrompt, userPrompt, new ModelPolicy(model), responseSchema, ct);
    }
}
