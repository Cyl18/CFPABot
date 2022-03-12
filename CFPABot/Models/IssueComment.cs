using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json.Serialization;
using System.Threading.Tasks;

namespace CFPABot.Models.I
{
    using J = System.Text.Json.Serialization.JsonPropertyNameAttribute;

    public partial class IssueComment
    {
        [J("action")] public string Action { get; set; }
        [J("number")] public long Number { get; set; }
        [J("pull_request")] public PullRequest PullRequest { get; set; }
        [J("repository")] public Repo Repository { get; set; }
        [J("sender")] public Sender Sender { get; set; }
    }

    public partial class PullRequest
    {
        [J("url")] public Uri Url { get; set; }
        [J("id")] public long Id { get; set; }
        [J("node_id")] public string NodeId { get; set; }
        [J("html_url")] public Uri HtmlUrl { get; set; }
        [J("diff_url")] public Uri DiffUrl { get; set; }
        [J("patch_url")] public Uri PatchUrl { get; set; }
        [J("issue_url")] public Uri IssueUrl { get; set; }
        [J("number")] public long Number { get; set; }
        [J("state")] public string State { get; set; }
        [J("locked")] public bool Locked { get; set; }
        [J("title")] public string Title { get; set; }
        [J("user")] public Sender User { get; set; }
        [J("body")] public object Body { get; set; }
        [J("created_at")] public DateTimeOffset CreatedAt { get; set; }
        [J("updated_at")] public DateTimeOffset UpdatedAt { get; set; }
        [J("closed_at")] public object ClosedAt { get; set; }
        [J("merged_at")] public object MergedAt { get; set; }
        [J("merge_commit_sha")] public object MergeCommitSha { get; set; }
        [J("assignee")] public object Assignee { get; set; }
        [J("assignees")] public object[] Assignees { get; set; }
        [J("requested_reviewers")] public object[] RequestedReviewers { get; set; }
        [J("requested_teams")] public object[] RequestedTeams { get; set; }
        [J("labels")] public object[] Labels { get; set; }
        [J("milestone")] public object Milestone { get; set; }
        [J("draft")] public bool Draft { get; set; }
        [J("commits_url")] public Uri CommitsUrl { get; set; }
        [J("review_comments_url")] public Uri ReviewCommentsUrl { get; set; }
        [J("review_comment_url")] public string ReviewCommentUrl { get; set; }
        [J("comments_url")] public Uri CommentsUrl { get; set; }
        [J("statuses_url")] public Uri StatusesUrl { get; set; }
        [J("head")] public Base Head { get; set; }
        [J("base")] public Base Base { get; set; }
        [J("_links")] public Links Links { get; set; }
        [J("author_association")] public string AuthorAssociation { get; set; }
        [J("auto_merge")] public object AutoMerge { get; set; }
        [J("active_lock_reason")] public object ActiveLockReason { get; set; }
        [J("merged")] public bool Merged { get; set; }
        [J("mergeable")] public object Mergeable { get; set; }
        [J("rebaseable")] public object Rebaseable { get; set; }
        [J("mergeable_state")] public string MergeableState { get; set; }
        [J("merged_by")] public object MergedBy { get; set; }
        [J("comments")] public long Comments { get; set; }
        [J("review_comments")] public long ReviewComments { get; set; }
        [J("maintainer_can_modify")] public bool MaintainerCanModify { get; set; }
        [J("commits")] public long Commits { get; set; }
        [J("additions")] public long Additions { get; set; }
        [J("deletions")] public long Deletions { get; set; }
        [J("changed_files")] public long ChangedFiles { get; set; }
    }

    public partial class Base
    {
        [J("label")] public string Label { get; set; }
        [J("ref")] public string Ref { get; set; }
        [J("sha")] public string Sha { get; set; }
        [J("user")] public Sender User { get; set; }
        [J("repo")] public Repo Repo { get; set; }
    }

    public partial class Repo
    {
        [J("id")] public long Id { get; set; }
        [J("node_id")] public string NodeId { get; set; }
        [J("name")] public string Name { get; set; }
        [J("full_name")] public string FullName { get; set; }
        [J("private")] public bool Private { get; set; }
        [J("owner")] public Sender Owner { get; set; }
        [J("html_url")] public Uri HtmlUrl { get; set; }
        [J("description")] public object Description { get; set; }
        [J("fork")] public bool Fork { get; set; }
        [J("url")] public Uri Url { get; set; }
        [J("forks_url")] public Uri ForksUrl { get; set; }
        [J("keys_url")] public string KeysUrl { get; set; }
        [J("collaborators_url")] public string CollaboratorsUrl { get; set; }
        [J("teams_url")] public Uri TeamsUrl { get; set; }
        [J("hooks_url")] public Uri HooksUrl { get; set; }
        [J("issue_events_url")] public string IssueEventsUrl { get; set; }
        [J("events_url")] public Uri EventsUrl { get; set; }
        [J("assignees_url")] public string AssigneesUrl { get; set; }
        [J("branches_url")] public string BranchesUrl { get; set; }
        [J("tags_url")] public Uri TagsUrl { get; set; }
        [J("blobs_url")] public string BlobsUrl { get; set; }
        [J("git_tags_url")] public string GitTagsUrl { get; set; }
        [J("git_refs_url")] public string GitRefsUrl { get; set; }
        [J("trees_url")] public string TreesUrl { get; set; }
        [J("statuses_url")] public string StatusesUrl { get; set; }
        [J("languages_url")] public Uri LanguagesUrl { get; set; }
        [J("stargazers_url")] public Uri StargazersUrl { get; set; }
        [J("contributors_url")] public Uri ContributorsUrl { get; set; }
        [J("subscribers_url")] public Uri SubscribersUrl { get; set; }
        [J("subscription_url")] public Uri SubscriptionUrl { get; set; }
        [J("commits_url")] public string CommitsUrl { get; set; }
        [J("git_commits_url")] public string GitCommitsUrl { get; set; }
        [J("comments_url")] public string CommentsUrl { get; set; }
        [J("issue_comment_url")] public string IssueCommentUrl { get; set; }
        [J("contents_url")] public string ContentsUrl { get; set; }
        [J("compare_url")] public string CompareUrl { get; set; }
        [J("merges_url")] public Uri MergesUrl { get; set; }
        [J("archive_url")] public string ArchiveUrl { get; set; }
        [J("downloads_url")] public Uri DownloadsUrl { get; set; }
        [J("issues_url")] public string IssuesUrl { get; set; }
        [J("pulls_url")] public string PullsUrl { get; set; }
        [J("milestones_url")] public string MilestonesUrl { get; set; }
        [J("notifications_url")] public string NotificationsUrl { get; set; }
        [J("labels_url")] public string LabelsUrl { get; set; }
        [J("releases_url")] public string ReleasesUrl { get; set; }
        [J("deployments_url")] public Uri DeploymentsUrl { get; set; }
        [J("created_at")] public DateTimeOffset CreatedAt { get; set; }
        [J("updated_at")] public DateTimeOffset UpdatedAt { get; set; }
        [J("pushed_at")] public DateTimeOffset PushedAt { get; set; }
        [J("git_url")] public string GitUrl { get; set; }
        [J("ssh_url")] public string SshUrl { get; set; }
        [J("clone_url")] public Uri CloneUrl { get; set; }
        [J("svn_url")] public Uri SvnUrl { get; set; }
        [J("homepage")] public object Homepage { get; set; }
        [J("size")] public long Size { get; set; }
        [J("stargazers_count")] public long StargazersCount { get; set; }
        [J("watchers_count")] public long WatchersCount { get; set; }
        [J("language")] public object Language { get; set; }
        [J("has_issues")] public bool HasIssues { get; set; }
        [J("has_projects")] public bool HasProjects { get; set; }
        [J("has_downloads")] public bool HasDownloads { get; set; }
        [J("has_wiki")] public bool HasWiki { get; set; }
        [J("has_pages")] public bool HasPages { get; set; }
        [J("forks_count")] public long ForksCount { get; set; }
        [J("mirror_url")] public object MirrorUrl { get; set; }
        [J("archived")] public bool Archived { get; set; }
        [J("disabled")] public bool Disabled { get; set; }
        [J("open_issues_count")] public long OpenIssuesCount { get; set; }
        [J("license")] public object License { get; set; }
        [J("allow_forking")] public bool AllowForking { get; set; }
        [J("is_template")] public bool IsTemplate { get; set; }
        [J("topics")] public object[] Topics { get; set; }
        [J("visibility")] public string Visibility { get; set; }
        [J("forks")] public long Forks { get; set; }
        [J("open_issues")] public long OpenIssues { get; set; }
        [J("watchers")] public long Watchers { get; set; }
        [J("default_branch")] public string DefaultBranch { get; set; }
        /*
        [J("allow_squash_merge")] public bool? AllowSquashMerge { get; set; }
        [J("allow_merge_commit")] public bool? AllowMergeCommit { get; set; }
        [J("allow_rebase_merge")] public bool? AllowRebaseMerge { get; set; }
        [J("allow_auto_merge")] public bool? AllowAutoMerge { get; set; }
        [J("delete_branch_on_merge")] public bool? DeleteBranchOnMerge { get; set; }
        [J("allow_update_branch")] public bool? AllowUpdateBranch { get; set; }
        */
    }

    public partial class Sender
    {
        [J("login")] public string Login { get; set; }
        [J("id")] public long Id { get; set; }
        [J("node_id")] public string NodeId { get; set; }
        [J("avatar_url")] public Uri AvatarUrl { get; set; }
        [J("gravatar_id")] public string GravatarId { get; set; }
        [J("url")] public Uri Url { get; set; }
        [J("html_url")] public Uri HtmlUrl { get; set; }
        [J("followers_url")] public Uri FollowersUrl { get; set; }
        [J("following_url")] public string FollowingUrl { get; set; }
        [J("gists_url")] public string GistsUrl { get; set; }
        [J("starred_url")] public string StarredUrl { get; set; }
        [J("subscriptions_url")] public Uri SubscriptionsUrl { get; set; }
        [J("organizations_url")] public Uri OrganizationsUrl { get; set; }
        [J("repos_url")] public Uri ReposUrl { get; set; }
        [J("events_url")] public string EventsUrl { get; set; }
        [J("received_events_url")] public Uri ReceivedEventsUrl { get; set; }
        [J("type")] public string Type { get; set; }
        [J("site_admin")] public bool SiteAdmin { get; set; }
    }

    public partial class Links
    {
        [J("self")] public Comments Self { get; set; }
        [J("html")] public Comments Html { get; set; }
        [J("issue")] public Comments Issue { get; set; }
        [J("comments")] public Comments Comments { get; set; }
        [J("review_comments")] public Comments ReviewComments { get; set; }
        [J("review_comment")] public Comments ReviewComment { get; set; }
        [J("commits")] public Comments Commits { get; set; }
        [J("statuses")] public Comments Statuses { get; set; }
    }

    public partial class Comments
    {
        [J("href")] public string Href { get; set; }
    }




}
