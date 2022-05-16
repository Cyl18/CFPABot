using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;

namespace CFPABot.Models.A
{
    using J = System.Text.Json.Serialization.JsonPropertyNameAttribute;

    public partial class AddonModel
    {
        [J("id")] public long Id { get; set; }
        [J("name")] public string Name { get; set; }
        [J("authors")] public Author[] Authors { get; set; }
        [J("attachments")] public Attachment[] Attachments { get; set; }
        [J("wikiUrl")] public string WikiUrl { get; set; }
        [J("sourceUrl")] public string SourceUrl { get; set; }
        [J("websiteUrl")] public Uri WebsiteUrl { get; set; }
        [J("gameId")] public long GameId { get; set; }
        [J("summary")] public string Summary { get; set; }
        [J("defaultFileId")] public long DefaultFileId { get; set; }
        [J("downloadCount")] public object DownloadCount { get; set; }
        [J("latestFiles")] public LatestFile[] LatestFiles { get; set; }
        [J("categories")] public Category[] Categories { get; set; }
        [J("status")] public long Status { get; set; }
        [J("primaryCategoryId")] public long PrimaryCategoryId { get; set; }
        [J("categorySection")] public CategorySection CategorySection { get; set; }
        [J("slug")] public string Slug { get; set; }
        [J("gameVersionLatestFiles")] public GameVersionLatestFile[] GameVersionLatestFiles { get; set; }
        [J("isFeatured")] public bool IsFeatured { get; set; }
        [J("popularityScore")] public double PopularityScore { get; set; }
        [J("gamePopularityRank")] public long GamePopularityRank { get; set; }
        [J("primaryLanguage")] public string PrimaryLanguage { get; set; }
        [J("gameSlug")] public string GameSlug { get; set; }
        [J("gameName")] public string GameName { get; set; }
        [J("portalName")] public string PortalName { get; set; }
        [J("dateModified")] public DateTimeOffset DateModified { get; set; }
        [J("dateCreated")] public DateTimeOffset DateCreated { get; set; }
        [J("dateReleased")] public DateTimeOffset DateReleased { get; set; }
        [J("isAvailable")] public bool IsAvailable { get; set; }
        [J("isExperiemental")] public bool IsExperiemental { get; set; }
        //[J("allowModDistribution")] public object AllowModDistribution { get; set; }
    }

    public partial class Attachment
    {
        [J("id")] public long Id { get; set; }
        [J("projectId")] public long ProjectId { get; set; }
        [J("description")] public string Description { get; set; }
        [J("isDefault")] public bool IsDefault { get; set; }
        [J("thumbnailUrl")] public Uri ThumbnailUrl { get; set; }
        [J("title")] public string Title { get; set; }
        [J("url")] public Uri Url { get; set; }
        [J("status")] public long Status { get; set; }
    }

    public partial class Author
    {
        [J("name")] public string Name { get; set; }
        [J("url")] public Uri Url { get; set; }
        [J("projectId")] public long ProjectId { get; set; }
        [J("id")] public long Id { get; set; }
        [J("projectTitleId")] public object ProjectTitleId { get; set; }
        [J("projectTitleTitle")] public object ProjectTitleTitle { get; set; }
        [J("userId")] public long UserId { get; set; }
        [J("twitchId")] public long TwitchId { get; set; }
    }

    public partial class Category
    {
        [J("categoryId")] public long CategoryId { get; set; }
        [J("name")] public string Name { get; set; }
        [J("url")] public Uri Url { get; set; }
        [J("avatarUrl")] public Uri AvatarUrl { get; set; }
        [J("parentId")] public long ParentId { get; set; }
        [J("rootId")] public long RootId { get; set; }
        [J("projectId")] public long ProjectId { get; set; }
        [J("avatarId")] public long AvatarId { get; set; }
        [J("gameId")] public long GameId { get; set; }
        [J("slug")] public string Slug { get; set; }
        [J("dateModified")] public DateTimeOffset DateModified { get; set; }
    }

    public partial class CategorySection
    {
        [J("id")] public long Id { get; set; }
        [J("gameId")] public long GameId { get; set; }
        [J("name")] public string Name { get; set; }
        [J("packageType")] public long PackageType { get; set; }
        [J("path")] public string Path { get; set; }
        [J("initialInclusionPattern")] public string InitialInclusionPattern { get; set; }
        [J("extraIncludePattern")] public object ExtraIncludePattern { get; set; }
        [J("gameCategoryId")] public long GameCategoryId { get; set; }
    }

    public partial class GameVersionLatestFile
    {
        [J("gameVersion")] public string GameVersion { get; set; }
        [J("projectFileId")] public long ProjectFileId { get; set; }
        [J("projectFileName")] public string ProjectFileName { get; set; }
        [J("fileType")] public long FileType { get; set; }
        [J("gameVersionFlavor")] public object GameVersionFlavor { get; set; }
        [J("gameVersionTypeId")] public long GameVersionTypeId { get; set; }
        [J("modLoader")] public long ModLoader { get; set; }
    }

    public partial class LatestFile
    {
        [J("id")] public long Id { get; set; }
        [J("displayName")] public string DisplayName { get; set; }
        [J("fileName")] public string FileName { get; set; }
        [J("fileDate")] public DateTimeOffset FileDate { get; set; }
        [J("fileLength")] public long FileLength { get; set; }
        [J("releaseType")] public long ReleaseType { get; set; }
        [J("fileStatus")] public long FileStatus { get; set; }
        [J("downloadUrl")] public Uri DownloadUrl { get; set; }
        [J("isAlternate")] public bool IsAlternate { get; set; }
        [J("alternateFileId")] public long AlternateFileId { get; set; }
        [J("dependencies")] public Dependency[] Dependencies { get; set; }
        [J("isAvailable")] public bool IsAvailable { get; set; }
        [J("modules")] public Module[] Modules { get; set; }
        [J("packageFingerprint")] public long PackageFingerprint { get; set; }
        [J("gameVersion")] public string[] GameVersion { get; set; }
        [J("sortableGameVersion")] public SortableGameVersion[] SortableGameVersion { get; set; }
        [J("installMetadata")] public object InstallMetadata { get; set; }
        [J("changelog")] public object Changelog { get; set; }
        [J("hasInstallScript")] public bool HasInstallScript { get; set; }
        [J("isCompatibleWithClient")] public bool IsCompatibleWithClient { get; set; }
        [J("categorySectionPackageType")] public long CategorySectionPackageType { get; set; }
        [J("restrictProjectFileAccess")] public long RestrictProjectFileAccess { get; set; }
        [J("projectStatus")] public long ProjectStatus { get; set; }
        [J("renderCacheId")] public long RenderCacheId { get; set; }
        [J("fileLegacyMappingId")] public object FileLegacyMappingId { get; set; }
        [J("projectId")] public long ProjectId { get; set; }
        [J("parentProjectFileId")] public object ParentProjectFileId { get; set; }
        [J("parentFileLegacyMappingId")] public object ParentFileLegacyMappingId { get; set; }
        [J("fileTypeId")] public object FileTypeId { get; set; }
        [J("exposeAsAlternative")] public object ExposeAsAlternative { get; set; }
        [J("packageFingerprintId")] public long PackageFingerprintId { get; set; }
        [J("gameVersionDateReleased")] public DateTimeOffset GameVersionDateReleased { get; set; }
        [J("gameVersionMappingId")] public long GameVersionMappingId { get; set; }
        [J("gameVersionId")] public long GameVersionId { get; set; }
        [J("gameId")] public long GameId { get; set; }
        [J("isServerPack")] public bool IsServerPack { get; set; }
        [J("serverPackFileId")] public object ServerPackFileId { get; set; }
        [J("gameVersionFlavor")] public object GameVersionFlavor { get; set; }
        [J("hashes")] public Hash[] Hashes { get; set; }
        [J("downloadCount")] public object DownloadCount { get; set; }
    }

    public partial class Dependency
    {
        [J("id")] public long Id { get; set; }
        [J("addonId")] public int AddonId { get; set; }
        [J("type")] public long Type { get; set; }
        [J("fileId")] public long FileId { get; set; }
    }

    public partial class Hash
    {
        [J("algorithm")] public long Algorithm { get; set; }
        [J("value")] public string Value { get; set; }
    }

    public partial class Module
    {
        [J("foldername")] public string Foldername { get; set; }
        [J("fingerprint")] public long Fingerprint { get; set; }
        [J("type")] public long Type { get; set; }
    }

    public partial class SortableGameVersion
    {
        [J("gameVersionPadded")] public string GameVersionPadded { get; set; }
        [J("gameVersion")] public string GameVersion { get; set; }
        [J("gameVersionReleaseDate")] public DateTimeOffset GameVersionReleaseDate { get; set; }
        [J("gameVersionName")] public string GameVersionName { get; set; }
        [J("gameVersionTypeId")] public long GameVersionTypeId { get; set; }
    }
}
