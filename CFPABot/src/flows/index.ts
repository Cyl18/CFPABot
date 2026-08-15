// src/flows/index.ts
// Public Flow factory: createAllPublicFlows() builds the registry-ready array.
// Individual Flows are imported directly from their domain modules.
// Spec: docs/specs/09-translation-review-delta.md §7.1

import type { Flow } from "@/types.js";

// ─── Imports for createAllPublicFlows factory ──────────────────────────

import { pr_get_context } from "./pr/index.js";
import { pr_get_detail } from "./pr/index.js";
import { pr_get_diff } from "./pr/index.js";
import { pr_read_file } from "./pr/index.js";
import { pr_list } from "./pr/index.js";
import { pr_compare } from "./pr/index.js";
import { pr_find_related } from "./pr/index.js";

import { translation_analyze } from "./translation/index.js";
import { translation_check_terms } from "./translation/index.js";
import { translation_check_keys } from "./translation/index.js";
import { review_thread_reply } from "./review/index.js";
import { review_comment } from "./review/index.js";
import { info_comment_refresh, info_comment_refresh_artifacts, info_comment_force_refresh } from "./info-comment/index.js";

import { checks_run_label_guard } from "./checks/checks_run_label_guard.js";

import { labels_sync } from "./labels/labels_sync.js";

import { packer_auto_approve } from "./packer/packer_auto_approve.js";

import { pr_cache_refresh } from "./cache/pr_cache_refresh.js";
import { modlist_refresh } from "./cache/modlist_refresh.js";
import { mapping_refresh } from "./cache/mapping_refresh.js";
import { modlist_build } from "./cache/modlist_build.js";
import { modlist_get } from "./cache/modlist_get.js";
import { dev_unmapped_slugs } from "./mappings/unmapped_slugs.js";

import { files_move_project } from "./files/files_move_project.js";
import { files_rename } from "./files/files_rename.js";
import { files_fetch_en_us } from "./files/files_fetch_en_us.js";
import { files_resolve_en_us_path } from "./files/files_resolve_en_us_path.js";
import { files_replace_text } from "./files/files_replace_text.js";
import { files_sort_keys } from "./files/files_sort_keys.js";
import { files_format } from "./files/files_format.js";
import { git_revert_commit } from "./git/git_revert_commit.js";
import { coauthor_add } from "./git/coauthor_add.js";
import { mapping_add } from "./mappings/mapping_add.js";
import { tm_build } from "./terminology/index.js";
import { compare_get_sources, compare_workspace, compare_upload, compare_special_diff, compare_list_workspaces, compare_cross_version } from "./compare/index.js";
import { terms_ngram_build } from "./terminology/index.js";
import { manual_rule_promote } from "./manual/index.js";
/**
 * Build the array of all public Flows registered at startup.
 * All current Flows are stateless; dependencies are obtained exclusively
 * through FlowContext. Re-introduce a factory options object only when a
 * concrete Flow needs injected construction-time dependencies.
 */
export function createAllPublicFlows(): Flow[] {
  const flows: Flow[] = [
    // PR - stateless
    pr_get_context,
    pr_get_detail,
    pr_get_diff,
    pr_read_file,
    pr_list,
    pr_compare,
    review_thread_reply,
    review_comment,
    pr_find_related,
    // Translation - stateless
    translation_analyze,
    translation_check_terms,
    translation_check_keys,
    // Info comment - stateless
    info_comment_refresh,
    info_comment_refresh_artifacts,
    info_comment_force_refresh,
    // Checks - stateless
    checks_run_label_guard,
    // Labels - stateless
    labels_sync,
    // Packer - stateless
    packer_auto_approve,
    // Cache - stateless
    pr_cache_refresh,
    modlist_refresh,
    mapping_refresh,
    modlist_build,
    modlist_get,
    dev_unmapped_slugs,
    // Files - stateless
    files_move_project,
    files_rename,
    files_fetch_en_us,
    files_resolve_en_us_path,
    files_replace_text,
    files_sort_keys,
    files_format,
    // Git - stateless
    git_revert_commit,
    coauthor_add,
    mapping_add,
    // Terminology - stateless
    tm_build,
    // Compare - stateless
    compare_get_sources,
    compare_workspace,
    compare_upload,
    compare_special_diff,
    compare_list_workspaces,
    compare_cross_version,
    // Terminology - stateless
    terms_ngram_build,
    // Manual - stateless
    manual_rule_promote,
  ];

  return flows;
}

