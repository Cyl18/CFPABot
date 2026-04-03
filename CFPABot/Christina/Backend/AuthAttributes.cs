using System;
using System.Threading.Tasks;
using CFPABot.Azusa;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;

namespace CFPABot.Christina.Backend
{
    /// <summary>
    /// Requires a valid GitHub OAuth login cookie. Returns 401 if not authenticated.
    /// The resolved GitHubClient is stored in HttpContext.Items["GhClient"] for the action to use.
    /// </summary>
    [AttributeUsage(AttributeTargets.Method | AttributeTargets.Class, AllowMultiple = false)]
    public sealed class RequireLoginAttribute : Attribute, IAsyncActionFilter
    {
        public async Task OnActionExecutionAsync(ActionExecutingContext context, ActionExecutionDelegate next)
        {
            var http = context.HttpContext;
            var client = LoginManager.GetGitHubClient(new Microsoft.AspNetCore.Http.HttpContextAccessor { HttpContext = http });
            if (client == null)
            {
                context.Result = new UnauthorizedResult();
                return;
            }

            try
            {
                var user = await client.User.Current().ConfigureAwait(false);
                http.Items["GhClient"] = client;
                http.Items["GhUser"]   = user;
            }
            catch
            {
                context.Result = new UnauthorizedResult();
                return;
            }

            await next();
        }
    }

    /// <summary>
    /// Requires a valid login AND that the user is a repo collaborator (admin).
    /// Returns 401 if not logged in, 403 if not admin.
    /// </summary>
    [AttributeUsage(AttributeTargets.Method | AttributeTargets.Class, AllowMultiple = false)]
    public sealed class RequireAdminAttribute : Attribute, IAsyncActionFilter
    {
        public async Task OnActionExecutionAsync(ActionExecutingContext context, ActionExecutionDelegate next)
        {
            var http = context.HttpContext;
            var client = LoginManager.GetGitHubClient(new Microsoft.AspNetCore.Http.HttpContextAccessor { HttpContext = http });
            if (client == null)
            {
                context.Result = new UnauthorizedResult();
                return;
            }

            try
            {
                var user = await client.User.Current().ConfigureAwait(false);
                if (!await LoginManager.IsAdmin(user).ConfigureAwait(false))
                {
                    context.Result = new ForbidResult();
                    return;
                }
                http.Items["GhClient"] = client;
                http.Items["GhUser"]   = user;
            }
            catch
            {
                context.Result = new UnauthorizedResult();
                return;
            }

            await next();
        }
    }

    /// <summary>Helper to read the resolved GitHub objects set by auth attributes.</summary>
    internal static class HttpContextAuthExtensions
    {
        public static Octokit.GitHubClient GetGhClient(this Microsoft.AspNetCore.Http.HttpContext ctx)
            => (Octokit.GitHubClient)ctx.Items["GhClient"]!;

        public static Octokit.User GetGhUser(this Microsoft.AspNetCore.Http.HttpContext ctx)
            => (Octokit.User)ctx.Items["GhUser"]!;
    }
}
