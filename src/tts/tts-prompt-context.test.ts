import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  prepareSpeechPromptContext,
  createMockSpeechProvider,
  installSpeechProviders,
  synthesizeMock,
  prepareSynthesisMock,
  synthesizeSpeech,
  clearRuntimeConfigSnapshot,
  type OpenClawConfig,
} from "./tts-runtime.test-support.js";

// mock-isolation: Machine-state workers are covered in tts-preferences.worker.test.ts;
// keep their process/database startup outside this speech-routing boundary fixture.
vi.mock("./tts-preferences.js", () => ({ prepareTtsPreferences: vi.fn(async () => ({})) }));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let prefsPath: string;
function prefs(tts: Record<string, unknown>) {
  writeFileSync(prefsPath, JSON.stringify({ tts }));
}
function config(): OpenClawConfig {
  return {
    tts: {
      auto: "always",
      provider: "irodori",
      providers: {
        irodori: { model: "irodori-tts", apiKey: "synthetic-private-key" },
        "speech-cpp": { model: "qwen3-tts-1.7b", apiKey: "synthetic-private-key" },
      },
    },
  };
}

beforeEach(() => {
  prefsPath = path.join(tempDirs.make("tts-prompt-context-"), "preferences.json");
  vi.stubEnv("OPENCLAW_TTS_PREFS", prefsPath);
  prefs({});
  installSpeechProviders(["irodori", "speech-cpp"].map((id) => createMockSpeechProvider(id)));
});
afterEach(() => {
  vi.unstubAllEnvs();
  clearRuntimeConfigSnapshot();
  synthesizeMock.mockClear();
  prepareSynthesisMock.mockClear();
});

describe("provider-aware speech prompt preparation", () => {
  it("returns only sanitized primary selection without synthesis or model calls", async () => {
    const result = await prepareSpeechPromptContext({ cfg: config() });
    expect(result).toEqual({
      version: 1,
      ready: true,
      provider: "irodori",
      model: "irodori-tts",
      auto: "always",
      allowText: true,
      maxLength: 1500,
    });
    expect(JSON.stringify(result)).not.toContain("synthetic-private-key");
    expect(synthesizeMock).not.toHaveBeenCalled();
    expect(prepareSynthesisMock).not.toHaveBeenCalled();
  });
  it("uses explicit provider preference over the persona and config", async () => {
    prefs({ provider: "speech-cpp", maxLength: 321 });
    const cfg = config();
    cfg.tts = { ...cfg.tts, persona: "sample", personas: { sample: { provider: "irodori" } } };
    expect(await prepareSpeechPromptContext({ cfg })).toMatchObject({
      provider: "speech-cpp",
      model: "qwen3-tts-1.7b",
      maxLength: 321,
    });
  });
  it("matches the actual synthesis model after persona binding", async () => {
    const cfg = config();
    cfg.tts = {
      ...cfg.tts,
      persona: "sample",
      personas: {
        sample: {
          provider: "speech-cpp",
          providers: { "speech-cpp": { model: "irodori-tts-mf" } },
          fallbackPolicy: "fail",
        },
      },
    };
    const selected = await prepareSpeechPromptContext({ cfg });
    expect(selected).toMatchObject({
      ready: true,
      provider: "speech-cpp",
      model: "irodori-tts-mf",
    });
    await synthesizeSpeech({ cfg, text: "短い台詞。" });
    expect(synthesizeMock.mock.calls[0]?.[0].providerConfig.model).toBe(selected.model);
  });
  it("does not suggest a fallback when the primary persona binding is missing", async () => {
    const cfg = config();
    cfg.tts = {
      ...cfg.tts,
      persona: "sample",
      personas: { sample: { provider: "irodori", fallbackPolicy: "fail", providers: {} } },
    };
    expect(await prepareSpeechPromptContext({ cfg })).toMatchObject({ ready: false });
  });
  it("honors channel and account layers through the existing owner", async () => {
    const cfg = config();
    cfg.channels = {
      "custom-speech": {
        tts: { provider: "speech-cpp" },
        accounts: {
          example: { tts: { providers: { "speech-cpp": { model: "irodori-tts-large" } } } },
        },
      },
    };
    expect(
      await prepareSpeechPromptContext({ cfg, channelId: "custom-speech", accountId: "example" }),
    ).toMatchObject({ provider: "speech-cpp", model: "irodori-tts-large" });
  });
  it("honors session auto mode and user text-override policy", async () => {
    const cfg = config();
    expect(await prepareSpeechPromptContext({ cfg, sessionAuto: "off" })).toMatchObject({
      ready: false,
      auto: "off",
    });
    prefs({ auto: "off" });
    expect(await prepareSpeechPromptContext({ cfg })).toMatchObject({ ready: false, auto: "off" });
    expect(await prepareSpeechPromptContext({ cfg, sessionAuto: "tagged" })).toMatchObject({
      ready: true,
      auto: "tagged",
    });
    cfg.tts = { ...cfg.tts, modelOverrides: { allowText: false } };
    expect(await prepareSpeechPromptContext({ cfg, sessionAuto: "always" })).toMatchObject({
      ready: false,
      allowText: false,
    });
  });
  it("does not cache a selection across preference changes", async () => {
    const cfg = config();
    expect(await prepareSpeechPromptContext({ cfg })).toMatchObject({ provider: "irodori" });
    prefs({ provider: "speech-cpp" });
    expect(await prepareSpeechPromptContext({ cfg })).toMatchObject({
      provider: "speech-cpp",
      model: "qwen3-tts-1.7b",
    });
  });
  it("respects the provider default model and configured hard text limit", async () => {
    const cfg = config();
    cfg.tts = { ...cfg.tts, maxTextLength: 120, providers: { irodori: {} } };
    installSpeechProviders([createMockSpeechProvider("irodori", { defaultModel: "irodori-tts" })]);
    expect(await prepareSpeechPromptContext({ cfg })).toMatchObject({
      model: "irodori-tts",
      maxLength: 120,
    });
  });
});
