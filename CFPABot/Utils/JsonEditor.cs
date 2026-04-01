using System;
using System.Collections.Generic;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

// by claude sonnet 4.6

namespace CFPABot.Utils
{
    public record JsonLine(int Id, int StartLine, string Key, string Value);

    public class JsonObjectEx
    {
        private abstract record Segment;

        // blank lines, comments, '{', '}' — stored verbatim
        private record RawSegment(string Content) : Segment;

        // Prefix : indent + "key": (everything before the opening quote of the value)
        // Suffix : rest after the closing quote of the value (comma, trailing comment, line ending)
        private record KvSegment(int Id, string Key, string Value, string Prefix, string Suffix) : Segment;

        private readonly List<Segment> _segments = new();
        private int _nextId;

        // Group 1 : prefix  (indent + "key": )
        // Group 2 : raw key content inside quotes
        // Group 3 : raw value content inside quotes
        // Group 4 : rest of line after value closing quote (comma, trailing comment)
        // Group 5 : line ending (\r\n | \n) or empty at EOF
        private static readonly Regex KvLineRegex = new(
            @"^(\s*""((?:[^""\\]|\\.)*)""\s*:\s*)""((?:[^""\\]|\\.)*)""\s*([^\r\n]*)(\r?\n|$)",
            RegexOptions.Compiled);

        public IList<JsonLine> Lines => BuildLinesList();

        private List<JsonLine> BuildLinesList()
        {
            var result = new List<JsonLine>();
            int lineNumber = 1;
            foreach (var seg in _segments)
            {
                if (seg is KvSegment kv)
                    result.Add(new JsonLine(kv.Id, lineNumber, kv.Key, kv.Value));
                lineNumber += CountNewlines(SegmentToText(seg));
            }
            return result;
        }

        private static string SegmentToText(Segment seg) => seg switch
        {
            RawSegment r => r.Content,
            KvSegment kv => kv.Prefix + "\"" + EscapeJsonValue(kv.Value) + "\"" + kv.Suffix,
            _ => throw new InvalidOperationException("Unknown segment type.")
        };

        private static int CountNewlines(string s)
        {
            int count = 0;
            foreach (char c in s) if (c == '\n') count++;
            return count;
        }

        private static string EscapeJsonValue(string value)
        {
            string json = JsonSerializer.Serialize(value);
            return json[1..^1]; // strip surrounding quotes
        }

        private static string UnescapeJsonValue(string rawValue) =>
            JsonSerializer.Deserialize<string>($"\"{rawValue}\"")!;

        public static JsonObjectEx CreateFromString(string jsonDocument)
        {
            var obj = new JsonObjectEx();
            int pos = 0;
            while (pos < jsonDocument.Length)
            {
                int eolIndex = jsonDocument.IndexOf('\n', pos);
                string line;
                if (eolIndex == -1)
                {
                    line = jsonDocument[pos..];
                    pos = jsonDocument.Length;
                }
                else
                {
                    line = jsonDocument[pos..(eolIndex + 1)];
                    pos = eolIndex + 1;
                }

                var match = KvLineRegex.Match(line);
                if (match.Success)
                {
                    string prefix   = match.Groups[1].Value;
                    string rawKey   = match.Groups[2].Value;
                    string rawValue = match.Groups[3].Value;
                    string suffix   = match.Groups[4].Value + match.Groups[5].Value;
                    int id = obj._nextId++;
                    obj._segments.Add(new KvSegment(
                        id,
                        UnescapeJsonValue(rawKey),
                        UnescapeJsonValue(rawValue),
                        prefix,
                        suffix));
                }
                else
                {
                    obj._segments.Add(new RawSegment(line));
                }
            }
            return obj;
        }

        public void SetValue(string key, string newValue)
        {
            int idx = RequireIndexByKey(key);
            var kv = (KvSegment)_segments[idx];
            _segments[idx] = kv with { Value = newValue };
        }

        public void DeleteLine(string key)
        {
            _segments.RemoveAt(RequireIndexByKey(key));
        }

        public void DeleteLine(int id)
        {
            _segments.RemoveAt(RequireIndexById(id));
        }

        public void AddLineAfterLine(int id, KeyValuePair<string, string> kvPair)
        {
            InsertAt(RequireIndexById(id) + 1, kvPair);
        }

        public void AddLinesAfterLine(int id, KeyValuePair<string, string>[] kvPairs)
        {
            int idx = RequireIndexById(id);
            for (int i = 0; i < kvPairs.Length; i++)
                InsertAt(idx + 1 + i, kvPairs[i]);
        }

        public void AddLineAfterLine(string key, KeyValuePair<string, string> kvPair)
        {
            InsertAt(RequireIndexByKey(key) + 1, kvPair);
        }

        public void AddLinesAfterLine(string key, KeyValuePair<string, string>[] kvPairs)
        {
            int idx = RequireIndexByKey(key);
            for (int i = 0; i < kvPairs.Length; i++)
                InsertAt(idx + 1 + i, kvPairs[i]);
        }

        public string ConstructJsonString()
        {
            var sb = new StringBuilder();
            foreach (var seg in _segments)
                sb.Append(SegmentToText(seg));
            return sb.ToString();
        }

        private void InsertAt(int idx, KeyValuePair<string, string> kvPair)
        {
            string indent      = DetectIndent();
            string lineEnding  = DetectLineEnding();
            string prefix      = $"{indent}\"{EscapeJsonValue(kvPair.Key)}\": ";
            string suffix      = "," + lineEnding;
            _segments.Insert(idx, new KvSegment(_nextId++, kvPair.Key, kvPair.Value, prefix, suffix));
        }

        private string DetectIndent()
        {
            foreach (var seg in _segments)
                if (seg is KvSegment kv)
                {
                    int i = 0;
                    while (i < kv.Prefix.Length && kv.Prefix[i] is ' ' or '\t') i++;
                    return kv.Prefix[..i];
                }
            return "    ";
        }

        private string DetectLineEnding()
        {
            foreach (var seg in _segments)
            {
                string text = SegmentToText(seg);
                if (text.Contains("\r\n")) return "\r\n";
                if (text.Contains('\n'))   return "\n";
            }
            return "\n";
        }

        private int RequireIndexByKey(string key)
        {
            int found = -1;
            for (int i = 0; i < _segments.Count; i++)
            {
                if (_segments[i] is not KvSegment kv || kv.Key != key) continue;
                if (found != -1)
                    throw new InvalidOperationException($"Duplicate key \"{key}\".");
                found = i;
            }
            if (found == -1)
                throw new KeyNotFoundException($"Key \"{key}\" not found.");
            return found;
        }

        private int RequireIndexById(int id)
        {
            for (int i = 0; i < _segments.Count; i++)
                if (_segments[i] is KvSegment kv && kv.Id == id)
                    return i;
            throw new ArgumentException($"Id {id} not found.");
        }
    }
}
