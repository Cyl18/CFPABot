// Unit tests for protocol-aware baseUrl normalization.
// Guards the anthropic-messages `/v1/v1/messages` double-path bug: the Anthropic
// SDK appends `/v1/messages` itself, so a stored `.../v1` root (the common
// OpenAI-style convention) must be stripped for that protocol only.
import { describe, expect, it } from "bun:test";
import { normalizeBaseUrlForProtocol } from "@/agent/llm-types.js";
import { buildModelsUrl } from "@/client/llm-models.js";

describe("normalizeBaseUrlForProtocol", () => {
  it("strips trailing /v1 for anthropic-messages", () => {
    expect(normalizeBaseUrlForProtocol("https://api.maolaoapi.cc/v1", "anthropic-messages"))
      .toBe("https://api.maolaoapi.cc");
  });

  it("strips trailing /v1/ (with slash) for anthropic-messages", () => {
    expect(normalizeBaseUrlForProtocol("https://api.maolaoapi.cc/v1/", "anthropic-messages"))
      .toBe("https://api.maolaoapi.cc");
  });

  it("keeps a root without /v1 for anthropic-messages", () => {
    expect(normalizeBaseUrlForProtocol("https://api.maolaoapi.cc", "anthropic-messages"))
      .toBe("https://api.maolaoapi.cc");
  });

  it("does not touch /v1beta (versioned root, not the /v1 convention)", () => {
    expect(normalizeBaseUrlForProtocol("https://api.example.com/v1beta", "anthropic-messages"))
      .toBe("https://api.example.com/v1beta");
  });

  it("keeps /v1 for openai-family protocols (SDK appends the operation path)", () => {
    expect(normalizeBaseUrlForProtocol("https://api.qiuqiutoken.com/v1", "openai-completions"))
      .toBe("https://api.qiuqiutoken.com/v1");
    expect(normalizeBaseUrlForProtocol("https://api.qiuqiutoken.com/v1", "openai-responses"))
      .toBe("https://api.qiuqiutoken.com/v1");
  });

  it("keeps /v1 when protocol is unset (defaults to openai-completions)", () => {
    expect(normalizeBaseUrlForProtocol("https://api.qiuqiutoken.com/v1", undefined))
      .toBe("https://api.qiuqiutoken.com/v1");
  });
});

describe("buildModelsUrl", () => {
  it("appends /models to the openai root (v1 preserved)", () => {
    expect(buildModelsUrl("https://api.qiuqiutoken.com/v1", "openai-completions"))
      .toBe("https://api.qiuqiutoken.com/v1/models");
    expect(buildModelsUrl("https://api.qiuqiutoken.com/v1"))
      .toBe("https://api.qiuqiutoken.com/v1/models");
  });

  it("re-adds /v1 for anthropic-messages roots stripped at save time", () => {
    // Stored value after normalizeBaseUrlForProtocol: no trailing /v1.
    expect(buildModelsUrl("https://api.qiuqiutoken.com", "anthropic-messages"))
      .toBe("https://api.qiuqiutoken.com/v1/models");
  });

  it("does not double /v1 when the caller passed a /v1 root directly", () => {
    expect(buildModelsUrl("https://api.qiuqiutoken.com/v1", "anthropic-messages"))
      .toBe("https://api.qiuqiutoken.com/v1/models");
  });

  it("keeps a versioned non-/v1 root as-is", () => {
    expect(buildModelsUrl("https://opencode.ai/zen/go/v1", "openai-completions"))
      .toBe("https://opencode.ai/zen/go/v1/models");
  });

  it("strips a stray /models tail then re-appends", () => {
    expect(buildModelsUrl("https://api.qiuqiutoken.com/v1/models/", "openai-completions"))
      .toBe("https://api.qiuqiutoken.com/v1/models");
  });
});
