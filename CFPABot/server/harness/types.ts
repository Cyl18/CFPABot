import type { ReviewDraft, WriteScope } from "@cfpa/contracts/api";

/** 资源读写共用的会话身份；读草稿、写草稿与发布都要用它定位会话 workspace。 */
export interface HarnessSession {
  sessionId: string;
  writeScope: WriteScope;
}

export interface HarnessHooks {
  onDraftSaved?(sessionId: string, draft: ReviewDraft): void | Promise<void>;
}
