/** Bot 评论与面板共用的 finding 顺序，避免同一报告两处排序漂移。 */
export const FINDING_CODE_RANK: Record<string, number> = {
  mod_not_found: 0,
  slug_changed: 0,
  mod_domain: 1,
  key_parity: 2,
  mod_en: 3,
};
