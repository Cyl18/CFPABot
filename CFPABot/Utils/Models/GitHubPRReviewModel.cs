namespace CFPABot.Utils.Models
{
    using System;
    using System.Globalization;
    using System.Text.Json;
    using System.Text.Json.Serialization;
    using J = System.Text.Json.Serialization.JsonPropertyNameAttribute;
    using N = System.Text.Json.Serialization.JsonIgnoreCondition;

    public partial class Line
    {
        [J("data")] public GitHubPRReviewData Data { get; set; }
    }
    public partial class GitHubPRReviewData
    {
        [J("repository")] public Repository Repository { get; set; }
    }

    public partial class Repository
    {
        [J("pullRequest")] public PullRequest1 PullRequest { get; set; }
    }

    public partial class PullRequest1
    {
        [J("reviewThreads")] public ReviewThreads ReviewThreads { get; set; }
    }

    public partial class ReviewThreads
    {
        [J("edges")] public ReviewThreadsEdge[] Edges { get; set; }
    }

    public partial class ReviewThreadsEdge
    {
        [J("node")] public PurpleNode Node { get; set; }
    }

    public partial class PurpleNode
    {
        [J("isOutdated")] public bool IsOutdated { get; set; }
        [J("isResolved")] public bool IsResolved { get; set; }
        [J("comments")] public Comments Comments { get; set; }
    }

    public partial class Comments
    {
        [J("edges")] public CommentsEdge[] Edges { get; set; }
    }

    public partial class CommentsEdge
    {
        [J("node")] public FluffyNode Node { get; set; }
    }

    public partial class FluffyNode
    {
        [J("fullDatabaseId")][JsonConverter(typeof(ParseStringConverter))] public long FullDatabaseId { get; set; }
    }

    public partial class Line
    {
        public static Line FromJson(string json) => JsonSerializer.Deserialize<Line>(json);
    }

    internal class ParseStringConverter : JsonConverter<long>
    {
        public override bool CanConvert(Type t) => t == typeof(long);

        public override long Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
        {
            var value = reader.GetString();
            long l;
            if (Int64.TryParse(value, out l))
            {
                return l;
            }
            throw new Exception("Cannot unmarshal type long");
        }

        public override void Write(Utf8JsonWriter writer, long value, JsonSerializerOptions options)
        {
            JsonSerializer.Serialize(writer, value.ToString(), options);
            return;
        }

        public static readonly ParseStringConverter Singleton = new ParseStringConverter();
    }

}
