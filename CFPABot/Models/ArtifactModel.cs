using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using J = System.Text.Json.Serialization.JsonPropertyNameAttribute;

namespace CFPABot.Models.Artifact
{
    public partial class ArtifactModel
    {
        [J("total_count")] public long TotalCount { get; set; }
        [J("artifacts")] public Artifact[] Artifacts { get; set; }
    }

    public partial class Artifact
    {
        [J("id")] public long Id { get; set; }
        [J("node_id")] public string NodeId { get; set; }
        [J("name")] public string Name { get; set; }
        [J("size_in_bytes")] public long SizeInBytes { get; set; }
        [J("url")] public Uri Url { get; set; }
        [J("archive_download_url")] public string ArchiveDownloadUrl { get; set; }
        [J("expired")] public bool Expired { get; set; }
        [J("created_at")] public DateTimeOffset CreatedAt { get; set; }
        [J("updated_at")] public DateTimeOffset UpdatedAt { get; set; }
        [J("expires_at")] public DateTimeOffset ExpiresAt { get; set; }
    }
}
