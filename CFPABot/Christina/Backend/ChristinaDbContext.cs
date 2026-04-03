using System;
using Microsoft.EntityFrameworkCore;

namespace CFPABot.Christina.Backend
{
    /// <summary>全局预置模型（admin 管理）</summary>
    public class GlobalModelPreset
    {
        public int Id { get; set; }
        public string Provider { get; set; } = "";     // "gemini" | "openrouter" | "custom"
        public string ModelId { get; set; } = "";
        public string DisplayName { get; set; } = "";
        public bool IsActive { get; set; } = true;
    }

    /// <summary>用户自定义模型（用户管理，custom provider 需填 BaseUrl）</summary>
    public class UserModelConfig
    {
        public int Id { get; set; }
        public string GithubUserId { get; set; } = "";
        public string Provider { get; set; } = "";     // "gemini" | "openrouter" | "custom"
        public string ModelId { get; set; } = "";
        public string DisplayName { get; set; } = "";
        public string? BaseUrl { get; set; }
        public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    }

    /// <summary>LLM review cache 索引行，用于快速按 PR+mod 查询历史。</summary>
    public class LlmReviewCacheIndex
    {
        public int Id { get; set; }
        public string Hash { get; set; } = "";
        public int Pr { get; set; }
        public string Mod { get; set; } = "";
        public DateTime CachedAt { get; set; }
        public string Models { get; set; } = "";        // JSON array string, e.g. ["gemini:xxx"]
        public string Importance { get; set; } = "";
        public bool Consistency { get; set; }
        public string? ContentHash { get; set; }
    }

    public class ChristinaDbContext : DbContext
    {
        public ChristinaDbContext(DbContextOptions<ChristinaDbContext> options) : base(options) { }

        public DbSet<GlobalModelPreset> GlobalModelPresets { get; set; } = null!;
        public DbSet<UserModelConfig> UserModelConfigs { get; set; } = null!;
        public DbSet<LlmReviewCacheIndex> LlmReviewCacheIndexes { get; set; } = null!;

        protected override void OnModelCreating(ModelBuilder modelBuilder)
        {
            modelBuilder.Entity<GlobalModelPreset>(e =>
            {
                e.HasKey(x => x.Id);
                e.Property(x => x.Provider).IsRequired().HasMaxLength(32);
                e.Property(x => x.ModelId).IsRequired().HasMaxLength(128);
                e.Property(x => x.DisplayName).IsRequired().HasMaxLength(128);
            });

            modelBuilder.Entity<UserModelConfig>(e =>
            {
                e.HasKey(x => x.Id);
                e.Property(x => x.GithubUserId).IsRequired().HasMaxLength(64);
                e.Property(x => x.Provider).IsRequired().HasMaxLength(32);
                e.Property(x => x.ModelId).IsRequired().HasMaxLength(128);
                e.Property(x => x.DisplayName).IsRequired().HasMaxLength(128);
                e.Property(x => x.BaseUrl).HasMaxLength(256);
            });

            modelBuilder.Entity<LlmReviewCacheIndex>(e =>
            {
                e.HasKey(x => x.Id);
                e.Property(x => x.Hash).IsRequired().HasMaxLength(24);
                e.HasIndex(x => new { x.Pr, x.Mod });
                e.HasIndex(x => x.Hash).IsUnique();
                e.Property(x => x.Mod).IsRequired().HasMaxLength(256);
                e.Property(x => x.Models).HasMaxLength(2048);
                e.Property(x => x.Importance).HasMaxLength(32);
                e.Property(x => x.ContentHash).HasMaxLength(24);
            });
        }
    }
}
