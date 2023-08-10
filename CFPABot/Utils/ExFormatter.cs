using Serilog.Formatting.Json;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System;
using CFPABot.DiffEngine;
using CFPABot.Exceptions;
using GammaLibrary.Extensions;

namespace CFPABot.Utils
{
    public class ExFormatter
    {
        public static string Format(string content, LangFileType? type = null)
        {
            type ??= LangFileWrapper.GuessType(content);
            switch (type)
            {
                case LangFileType.Lang:
                    return RemoveEmptyLines(content.Split('\n').Select(x => x.TrimStart(' ')).Connect("\n"));
                    break;
                case LangFileType.Json:
                    return RemoveEmptyLines(JsonHelper.FormatJson(content));
                    break;
            }

            throw new CommandException("ExFormatter 遇到了不可能出现的情况???");
        }

        static string RemoveEmptyLines(string s)
        {
            var list = s.Split('\n').ToList();
            if (list.Count <= 2) return s;
            
            var flag = false;
            var lineCount = list.Count;
            for (var i = 0; i < lineCount; i++)
            {
                var line = list[i];

                if (line.IsNullOrWhiteSpace())
                {
                    if (flag)
                    {
                        list.RemoveAt(i);
                        lineCount--;
                    }
                    else
                    {
                        flag = true;
                    }
                }
                else
                {
                    flag = false;
                }
            }

            return list.Connect("\n");
        }
    }


    // https://stackoverflow.com/questions/4580397/json-formatter-in-c
    class JsonHelper
    {
        private const string INDENT_STRING = "    ";
        public static string FormatJson(string str)
        {
            var indent = 0;
            var quoted = false;
            var sb = new StringBuilder();
            for (var i = 0; i < str.Length; i++)
            {
                var ch = str[i];
                switch (ch)
                {
                    case '{':
                    case '[':
                        sb.Append(ch);
                        if (!quoted)
                        {
                            sb.AppendLine();
                            Enumerable.Range(0, ++indent).ForEach(item => sb.Append(INDENT_STRING));
                        }
                        break;
                    case '}':
                    case ']':
                        if (!quoted)
                        {
                            sb.AppendLine();
                            Enumerable.Range(0, --indent).ForEach(item => sb.Append(INDENT_STRING));
                        }
                        sb.Append(ch);
                        break;
                    case '"':
                        sb.Append(ch);
                        bool escaped = false;
                        var index = i;
                        while (index > 0 && str[--index] == '\\')
                            escaped = !escaped;
                        if (!escaped)
                            quoted = !quoted;
                        break;
                    case ',':
                        sb.Append(ch);
                        if (!quoted)
                        {
                            sb.AppendLine();
                            Enumerable.Range(0, indent).ForEach(item => sb.Append(INDENT_STRING));
                        }
                        break;
                    case ':':
                        sb.Append(ch);
                        if (!quoted)
                            sb.Append(" ");
                        break;
                    default:
                        sb.Append(ch);
                        break;
                }
            }
            return sb.ToString();
        }
    }

    static class Extensions
    {
        public static void ForEach<T>(this IEnumerable<T> ie, Action<T> action)
        {
            foreach (var i in ie)
            {
                action(i);
            }
        }
    }
}
