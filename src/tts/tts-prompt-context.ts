import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig, TtsAutoMode } from "../config/types.js";
import { prepareTtsPreferences } from "./tts-preferences.js";
import { resolveTtsSettingsSnapshot } from "./tts-settings.js";
import { resolveReadySpeechProvider, withOwnedTtsRequest } from "./tts-synthesis-support.js";

export type SpeechPromptContext = {
  version: 1;
  ready: boolean;
  auto: TtsAutoMode;
  allowText: boolean;
  maxLength: number;
  provider?: string;
  model?: string;
  persona?: string;
};

/** Read-only preparation; selection and provider lifetime are owned by normal TTS. */
export async function prepareSpeechPromptContext(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  channelId?: string;
  accountId?: string;
  sessionAuto?: string;
}): Promise<SpeechPromptContext> {
  const settings = resolveTtsSettingsSnapshot({
    ...params,
    preparedTtsPreferences: await prepareTtsPreferences(),
  });
  const base: SpeechPromptContext = {
    version: 1,
    ready: false,
    auto: settings.autoMode,
    allowText: settings.config.modelOverrides.allowText,
    maxLength: Math.min(settings.maxLength, settings.config.maxTextLength),
    ...(settings.personaId ? { persona: settings.personaId } : {}),
  };
  if (base.auto === "off" || !base.allowText) {
    return base;
  }
  return await withOwnedTtsRequest(
    { ...params, text: "", prefsPath: settings.prefsPath, disableFallback: true },
    async (setup) => {
      if ("error" in setup || !setup.providers[0]) {
        return base;
      }
      const candidate = setup.providers[0];
      const ready = await resolveReadySpeechProvider({
        ...setup,
        provider: candidate.provider,
        voiceModel: candidate.voiceModel,
        target: "audio-file",
        providerRegistry: await setup.prepareProviderRegistry(),
      });
      if (ready.kind !== "ready") {
        return base;
      }
      const model =
        normalizeOptionalString(ready.providerConfig.model) ??
        normalizeOptionalString(ready.providerConfig.modelId) ??
        ready.provider.defaultModel;
      return {
        ...base,
        ready: true,
        provider: ready.provider.id,
        ...(model ? { model } : {}),
      };
    },
  );
}
