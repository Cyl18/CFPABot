using System;
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
namespace CFPABot.Utils.LLMs
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

    public sealed class OpenRouterClient
    {
        private readonly HttpClient _http;
        private readonly ApiKeyPool _keyPool;
        private readonly JsonSerializerOptions _json;

        private const string Endpoint = "https://openrouter.ai/api/v1/responses";

        public OpenRouterClient(ApiKeyPool keyPool, HttpClient? httpClient = null)
        {
            _keyPool = keyPool;
            _http = httpClient ?? new HttpClient();
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
            var context = new List<object>(request.Input);

            foreach (var model in modelPolicy.Enumerate())
            {
                request.Model = model;

                while (true)
                {
                    var apiKey = _keyPool.Acquire();
                    using var msg = BuildHttpRequest(apiKey, request, context);

                    var resp = await SendWith429Retry(msg, apiKey, ct);

                    if (!resp.IsSuccessStatusCode)
                        break;

                    var payload = await ParseAsync(resp);
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
            var attempt = 0;

            while (true)
            {
                var resp = await _http.SendAsync(msg, ct);

                if (resp.StatusCode != (HttpStatusCode)429)
                    return resp;

                _keyPool.Penalize(apiKey);

                attempt++;
                var delay = RetryPolicy.ComputeDelay(resp, attempt);
                await Task.Delay(delay, ct);
            }
        }

        private async Task<ResponseEnvelope> ParseAsync(HttpResponseMessage resp)
        {
            var json = await resp.Content.ReadAsStringAsync();
            return JsonSerializer.Deserialize<ResponseEnvelope>(json, _json)
                   ?? throw new InvalidOperationException("Invalid response");
        }
    }

    public sealed class ApiKeyPool
    {
        private readonly List<ApiKeyState> _keys;
        private int _index;

        public ApiKeyPool(IEnumerable<string> keys)
        {
            _keys = new List<ApiKeyState>();
            foreach (var k in keys)
                _keys.Add(new ApiKeyState(k));
        }

        public string Acquire()
        {
            lock (_keys)
            {
                for (int i = 0; i < _keys.Count; i++)
                {
                    var idx = (_index + i) % _keys.Count;
                    if (_keys[idx].IsAvailable)
                    {
                        _index = idx + 1;
                        return _keys[idx].Key;
                    }
                }
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
                _cooldownUntil = DateTime.UtcNow.AddSeconds(10);
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
    }

    public sealed class FunctionCall
    {
        public string Name = "";
        public string Arguments = "";
        public string CallId = "";
    }

    public sealed class ResponseRequest
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
