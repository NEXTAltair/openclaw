import type { SessionsPatchParams } from "../../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { SessionEntryCommitContext } from "../../config/sessions/session-accessor.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { triggerSessionPatchHook } from "../session-patch-hooks.js";
import { emitSessionsChanged } from "./session-change-event.js";
import { registerCommittedSessionCategory } from "./session-create-category.js";
import { persistSessionPatchModelSelection } from "./sessions-patch-model-selection.js";
import type { GroupAdmissionResult } from "./sessions-patch-types.js";
import type { GatewayRequestContext } from "./types.js";

/** Publish committed patch effects even when active-runtime application later reports an error. */
export async function publishSessionPatchEffects(params: {
  cfg: OpenClawConfig;
  context: GatewayRequestContext;
  callerScopes: readonly string[];
  targets: Array<{
    accessChanged: boolean;
    entry: SessionEntry;
    target: {
      canonicalKey: string;
      fullPatch: SessionsPatchParams;
      requestedAgentId?: string;
      targetAgentId: string;
    };
  }>;
}): Promise<boolean> {
  const archivedSessionKeys = new Set<string>();
  for (const { target, entry, accessChanged } of params.targets) {
    triggerSessionPatchHook({
      cfg: params.cfg,
      sessionEntry: entry,
      sessionKey: target.canonicalKey,
      patch: target.fullPatch,
    });
    persistSessionPatchModelSelection({
      cfg: params.cfg,
      callerScopes: params.callerScopes,
      entry,
      patch: target.fullPatch,
      sessionKey: target.canonicalKey,
      targetAgentId: target.targetAgentId,
    });
    emitSessionsChanged(
      params.context,
      {
        sessionKey: target.canonicalKey,
        ...(target.requestedAgentId ? { agentId: target.requestedAgentId } : {}),
        reason: "patch",
        ...(target.fullPatch.model !== undefined || target.fullPatch.agentRuntime !== undefined
          ? { catalogChanged: true }
          : {}),
      },
      { accessChanged },
    );
    if (typeof target.fullPatch.archived === "boolean") {
      params.context.sessionActivitySummaries?.handleLifecycle({
        sessionKey: target.canonicalKey,
        agentId: target.targetAgentId,
        reason: target.fullPatch.archived ? "archive" : "unarchive",
      });
    }
    if (target.fullPatch.archived === true) {
      archivedSessionKeys.add(target.canonicalKey);
    }
  }

  // Archiving organizes conversations; only automation operations change job enablement.
  return archivedSessionKeys.size > 0;
}

/** Only applied assignments may repair the catalog; detached and status-model no-ops cannot. */
export function createSessionPatchCategoryRegistration(params: {
  patch: { category?: SessionsPatchParams["category"] };
  context: GatewayRequestContext;
}) {
  const category = params.patch.category;
  return async (result: GroupAdmissionResult, source: SessionEntryCommitContext): Promise<void> => {
    if (
      typeof category === "string" &&
      result.kind === "complete" &&
      result.outcomes.some(
        (outcome) => outcome.ok && outcome.applied && outcome.entry.category === category.trim(),
      )
    ) {
      await registerCommittedSessionCategory(category, params.context, source);
    }
  };
}
