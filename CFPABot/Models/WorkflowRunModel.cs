using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using J = System.Text.Json.Serialization.JsonPropertyNameAttribute;

namespace CFPABot.Models.Workflow
{

    public partial class WorkflowRunModel
    {
        [J("total_count")] public long TotalCount { get; set; }
        [J("workflow_runs")] public WorkflowRun[] WorkflowRuns { get; set; }
    }

    public partial class WorkflowRun
    {
        [J("id")] public long Id { get; set; }
        [J("name")] public string Name { get; set; }
        [J("node_id")] public string NodeId { get; set; }
        [J("head_branch")] public string HeadBranch { get; set; }
        [J("head_sha")] public string HeadSha { get; set; }
        [J("run_number")] public long RunNumber { get; set; }
        [J("event")] public string Event { get; set; }
        [J("status")] public string Status { get; set; }
        [J("conclusion")] public string Conclusion { get; set; }
        [J("workflow_id")] public long WorkflowId { get; set; }
        [J("check_suite_id")] public long CheckSuiteId { get; set; }
        [J("check_suite_node_id")] public string CheckSuiteNodeId { get; set; }
        [J("url")] public string Url { get; set; }
        [J("html_url")] public string HtmlUrl { get; set; }
        [J("pull_requests")] public object[] PullRequests { get; set; }
        [J("created_at")] public DateTimeOffset CreatedAt { get; set; }
        [J("updated_at")] public DateTimeOffset UpdatedAt { get; set; }
        [J("actor")] public Actor Actor { get; set; }
        [J("run_attempt")] public long RunAttempt { get; set; }
        [J("run_started_at")] public DateTimeOffset RunStartedAt { get; set; }
        [J("triggering_actor")] public Actor TriggeringActor { get; set; }
        [J("jobs_url")] public string JobsUrl { get; set; }
        [J("logs_url")] public string LogsUrl { get; set; }
        [J("check_suite_url")] public string CheckSuiteUrl { get; set; }
        [J("artifacts_url")] public string ArtifactsUrl { get; set; }
        [J("cancel_url")] public string CancelUrl { get; set; }
        [J("rerun_url")] public string RerunUrl { get; set; }
        [J("previous_attempt_url")] public object PreviousAttemptUrl { get; set; }
        [J("workflow_url")] public string WorkflowUrl { get; set; }
        [J("head_commit")] public HeadCommit HeadCommit { get; set; }
        [J("repository")] public Repository Repository { get; set; }
        [J("head_repository")] public Repository HeadRepository { get; set; }
    }

    public partial class Actor
    {
        [J("login")] public string Login { get; set; }
        [J("id")] public long Id { get; set; }
        [J("node_id")] public string NodeId { get; set; }
        [J("avatar_url")] public string AvatarUrl { get; set; }
        [J("gravatar_id")] public string GravatarId { get; set; }
        [J("url")] public string Url { get; set; }
        [J("html_url")] public string HtmlUrl { get; set; }
        [J("followers_url")] public string FollowersUrl { get; set; }
        [J("following_url")] public string FollowingUrl { get; set; }
        [J("gists_url")] public string GistsUrl { get; set; }
        [J("starred_url")] public string StarredUrl { get; set; }
        [J("subscriptions_url")] public string SubscriptionsUrl { get; set; }
        [J("organizations_url")] public string OrganizationsUrl { get; set; }
        [J("repos_url")] public string ReposUrl { get; set; }
        [J("events_url")] public string EventsUrl { get; set; }
        [J("received_events_url")] public string ReceivedEventsUrl { get; set; }
        [J("type")] public string Type { get; set; }
        [J("site_admin")] public bool SiteAdmin { get; set; }
    }

    public partial class HeadCommit
    {
        [J("id")] public string Id { get; set; }
        [J("tree_id")] public string TreeId { get; set; }
        [J("message")] public string Message { get; set; }
        [J("timestamp")] public DateTimeOffset Timestamp { get; set; }
        [J("author")] public Author Author { get; set; }
        [J("committer")] public Author Committer { get; set; }
    }

    public partial class Author
    {
        [J("name")] public string Name { get; set; }
        [J("email")] public string Email { get; set; }
    }

    public partial class Repository
    {
        [J("id")] public long Id { get; set; }
        [J("node_id")] public string NodeId { get; set; }
        [J("name")] public string Name { get; set; }
        [J("full_name")] public string FullName { get; set; }
        [J("private")] public bool Private { get; set; }
        [J("owner")] public Actor Owner { get; set; }
        [J("html_url")] public string HtmlUrl { get; set; }
        [J("description")] public string Description { get; set; }
        [J("fork")] public bool Fork { get; set; }
        [J("url")] public string Url { get; set; }
        [J("forks_url")] public string ForksUrl { get; set; }
        [J("keys_url")] public string KeysUrl { get; set; }
        [J("collaborators_url")] public string CollaboratorsUrl { get; set; }
        [J("teams_url")] public string TeamsUrl { get; set; }
        [J("hooks_url")] public string HooksUrl { get; set; }
        [J("issue_events_url")] public string IssueEventsUrl { get; set; }
        [J("events_url")] public string EventsUrl { get; set; }
        [J("assignees_url")] public string AssigneesUrl { get; set; }
        [J("branches_url")] public string BranchesUrl { get; set; }
        [J("tags_url")] public string TagsUrl { get; set; }
        [J("blobs_url")] public string BlobsUrl { get; set; }
        [J("git_tags_url")] public string GitTagsUrl { get; set; }
        [J("git_refs_url")] public string GitRefsUrl { get; set; }
        [J("trees_url")] public string TreesUrl { get; set; }
        [J("statuses_url")] public string StatusesUrl { get; set; }
        [J("languages_url")] public string LanguagesUrl { get; set; }
        [J("stargazers_url")] public string StargazersUrl { get; set; }
        [J("contributors_url")] public string ContributorsUrl { get; set; }
        [J("subscribers_url")] public string SubscribersUrl { get; set; }
        [J("subscription_url")] public string SubscriptionUrl { get; set; }
        [J("commits_url")] public string CommitsUrl { get; set; }
        [J("git_commits_url")] public string GitCommitsUrl { get; set; }
        [J("comments_url")] public string CommentsUrl { get; set; }
        [J("issue_comment_url")] public string IssueCommentUrl { get; set; }
        [J("contents_url")] public string ContentsUrl { get; set; }
        [J("compare_url")] public string CompareUrl { get; set; }
        [J("merges_url")] public string MergesUrl { get; set; }
        [J("archive_url")] public string ArchiveUrl { get; set; }
        [J("downloads_url")] public string DownloadsUrl { get; set; }
        [J("issues_url")] public string IssuesUrl { get; set; }
        [J("pulls_url")] public string PullsUrl { get; set; }
        [J("milestones_url")] public string MilestonesUrl { get; set; }
        [J("notifications_url")] public string NotificationsUrl { get; set; }
        [J("labels_url")] public string LabelsUrl { get; set; }
        [J("releases_url")] public string ReleasesUrl { get; set; }
        [J("deployments_url")] public string DeploymentsUrl { get; set; }
    }


}
