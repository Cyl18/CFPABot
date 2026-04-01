#nullable enable
using System;
using CFPABot.Utils;

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
    using System.Threading;
    using System.Threading.Tasks;
    using Serilog;

    public sealed class OpenRouterClient
    {
        private readonly HttpClient _http;
        private readonly ApiKeyPool _keyPool;
        private readonly JsonSerializerOptions _json;

        private const string Endpoint = "https://openrouter.ai/api/v1/responses";

        public OpenRouterClient()
        {
            _keyPool = new ApiKeyPool(new []{Constants.OpenRouterApiKey, Constants.OpenRouterApiKey2 });
            _http = new HttpClient();
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

                    var payload = JsonSerializer.Deserialize<ResponseEnvelope>(responseBody, _json)
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
                JsonSerializer.Serialize(body, _json),
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
                var resp = await _http.SendAsync(clone, ct);

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
            return JsonSerializer.Deserialize<ResponseEnvelope>(json, _json)
                   ?? throw new InvalidOperationException("Invalid response");
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
                    JsonSerializer.Serialize(body, _json),
                    Encoding.UTF8,
                    "application/json");

                var resp = await _http.SendAsync(msg, ct);
                var responseBody = await resp.Content.ReadAsStringAsync();
                await session.WriteAsync(new
                {
                    timestamp = DateTime.UtcNow,
                    client = "openrouter",
                    method = "query",
                    model,
                    attempt,
                    success = resp.IsSuccessStatusCode,
                    statusCode = (int)resp.StatusCode,
                    prompt = new { user = userPrompt },
                    response = responseBody
                });

                if (!resp.IsSuccessStatusCode)
                    continue;

                var payload = JsonSerializer.Deserialize<ResponseEnvelope>(responseBody, _json)
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
                    JsonSerializer.Serialize(body, _json),
                    Encoding.UTF8,
                    "application/json");

                var resp = await _http.SendAsync(msg, ct);
                var responseBody = await resp.Content.ReadAsStringAsync();
                await session.WriteAsync(new
                {
                    timestamp = DateTime.UtcNow,
                    client = "openrouter",
                    method = "query-with-system",
                    model,
                    attempt,
                    success = resp.IsSuccessStatusCode,
                    statusCode = (int)resp.StatusCode,
                    prompt = new { system = systemPrompt, user = userPrompt },
                    response = responseBody
                });

                if (!resp.IsSuccessStatusCode)
                    continue;

                var payload = JsonSerializer.Deserialize<ResponseEnvelope>(responseBody, _json)
                              ?? throw new InvalidOperationException("Invalid response");
                var text = payload.GetText();
                if (text is not null)
                    return text;
            }

            throw new InvalidOperationException("All models exhausted");
        }
    }

    public sealed class ApiKeyPool
    {
        private readonly List<ApiKeyState> _keys;

        public ApiKeyPool(IEnumerable<string> keys)
        {
            _keys = new List<ApiKeyState>();
            foreach (var k in keys)
                _keys.Add(new ApiKeyState(k));
        }

        public async Task<string> Acquire()
        {
            for (int j = 0; j < 3; j++)
            {
                lock (_keys)
                {
                    var available = _keys.FindAll(k => k.IsAvailable);
                    if (available.Count > 0)
                        return available[Random.Shared.Next(available.Count)].Key;
                }

                await Task.Delay(50);
            }
            throw new InvalidOperationException("No API key available");
        }

        public void Penalize(string key)
        {
            lock (_keys)
            {
                _keys.Find(k => k.Key == key)?.Backoff();
            }
        }

        private sealed class ApiKeyState
        {
            public string Key { get; }
            private DateTime _cooldownUntil;

            public bool IsAvailable => DateTime.UtcNow >= _cooldownUntil;

            public ApiKeyState(string key) => Key = key;

            public void Backoff()
            {
                _cooldownUntil = DateTime.UtcNow.AddSeconds(0.2);
            }
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
}
