import { randomUUID } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import type { MemoryAudience } from "../../../plugins/memory-provider-types.js";

const { fakeSessionOwner, fakeSessionGenerationModule, fakeSessionEntryReadModule } =
  await vi.hoisted(() => import("../../../plugins/memory-audience.test-support.js"));

const mocks = vi.hoisted(() => ({
  kind: undefined as "native" | "legacy" | undefined,
  warn: vi.fn(),
  info: vi.fn(),
}));

// mock-isolation: the fake session owner replaces SQLite generation facts.
vi.mock(
  "../../../config/sessions/session-delivery-generation.js",
  () => fakeSessionGenerationModule,
);
// mock-isolation: the fake session owner replaces worker-thread session reads.
vi.mock("../../../config/sessions/session-entry-read-runtime.js", () => fakeSessionEntryReadModule);
// mock-isolation: Pins the loaded memory owner kind, which the attempt audience must not depend on.
vi.mock("../../../plugins/memory-state.js", () => ({
  resolveLoadedMemoryProviderKind: () => mocks.kind,
}));
// mock-isolation: captures the attempt's log levels without emitting them.
vi.mock("../logger.js", () => ({ log: { warn: mocks.warn, info: mocks.info, debug: vi.fn() } }));

import { buildEmbeddedAgentHookContext } from "./agent-hook-context.js";
import { resolveEmbeddedAttemptMemoryAudience } from "./attempt-memory-audience.js";

const ROOT_KEY = "agent:main:root";
const CHILD_KEY = "agent:main:subagent:child";
const STORE_PATH = "/tmp/openclaw-attempt-memory-audience/main.sqlite";
const entry = () => ({ sessionId: randomUUID(), lifecycleRevision: randomUUID(), updatedAt: 1 });

const attempt = {
  agentId: "main",
  sessionKey: CHILD_KEY,
  sessionId: "child-session",
  run: { senderIsOwner: false },
  admission: { entry: { sessionId: "child-session", updatedAt: 1 }, storePath: STORE_PATH },
};

// One admitted turn on a current root row, as the dispatch passes it.
function rootTurn(chatType: "direct" | "group", senderIsOwner: boolean | undefined) {
  const sessionKey = `agent:main:dashboard:${randomUUID()}`;
  const row = { ...entry(), chatType };
  fakeSessionOwner.rows.set(sessionKey, row);
  return {
    agentId: "main",
    sessionKey,
    sessionId: row.sessionId,
    run: { senderIsOwner },
    admission: { entry: row, storePath: STORE_PATH },
    row,
  };
}

// A spawned child whose receipt names its parent's incarnation at spawn time.
function spawnedChildAttempt(kind: "stale" | "unverified") {
  const parent = { ...entry(), chatType: "direct" as const };
  const child = {
    ...entry(),
    spawnedBy: ROOT_KEY,
    parentSessionKey: ROOT_KEY,
    spawnedBySessionId: parent.sessionId,
    parentSessionLifecycleRevision: parent.lifecycleRevision,
    spawnedBySenderIsOwner: true,
  };
  fakeSessionOwner.rows.set(ROOT_KEY, parent);
  fakeSessionOwner.rows.set(CHILD_KEY, child);
  if (kind === "stale") {
    fakeSessionOwner.rows.set(ROOT_KEY, { ...parent, lifecycleRevision: randomUUID() });
  } else {
    fakeSessionOwner.pendingKeys.add(ROOT_KEY);
  }
  return {
    ...attempt,
    sessionId: child.sessionId,
    admission: { entry: child, storePath: STORE_PATH },
  };
}

function promptHookContext(
  turn: { sessionKey: string; sessionId: string },
  audience?: MemoryAudience,
) {
  return buildEmbeddedAgentHookContext(
    {
      runId: "run-1",
      sessionKey: turn.sessionKey,
      sessionId: turn.sessionId,
      workspaceDir: "/tmp/openclaw-attempt-memory-audience/workspace",
      memoryAudience: audience,
    },
    "main",
    undefined,
  );
}

beforeEach(() => {
  mocks.kind = undefined;
  mocks.warn.mockReset();
  mocks.info.mockReset();
  fakeSessionOwner.reset();
});

it.each(["legacy", "native"] as const)(
  "gives prompt hooks the owner's private audience on a direct root under a %s memory owner",
  async (kind) => {
    mocks.kind = kind;
    const turn = rootTurn("direct", true);
    const { memoryAudience, release } = await resolveEmbeddedAttemptMemoryAudience(turn);
    expect(memoryAudience).toEqual({ kind: "owner-private", agentId: "main" });

    const hook = promptHookContext(turn, memoryAudience);
    expect(hook.memoryAudience).toBe(memoryAudience);
    expect(() => hook.assertMemoryAudienceCurrent?.()).not.toThrow();
    // The host binds the audience to the turn's session; another session cannot present it.
    expect(() => promptHookContext({ ...turn, sessionKey: ROOT_KEY }, memoryAudience)).toThrow(
      "memory audience is bound to a different session",
    );

    // A reset before the hook publishes its context revokes the guard.
    fakeSessionOwner.rows.set(turn.sessionKey, { ...turn.row, lifecycleRevision: randomUUID() });
    expect(() => hook.assertMemoryAudienceCurrent?.()).toThrow(
      "memory audience is no longer current",
    );
    release();
    expect(fakeSessionOwner.activeLeases).toBe(0);
  },
);

it("revokes a prompt hook's audience when its attempt releases it", async () => {
  mocks.kind = "legacy";
  const turn = rootTurn("direct", true);
  const { memoryAudience, release } = await resolveEmbeddedAttemptMemoryAudience(turn);
  const hook = promptHookContext(turn, memoryAudience);

  release();
  expect(() => hook.assertMemoryAudienceCurrent?.()).toThrow(
    "memory audience was released by its owner",
  );
  expect(fakeSessionOwner.activeLeases).toBe(0);
});

it.each([
  ["a group root", "group", true],
  ["a non-owner direct turn", "direct", false],
  ["an unverified sender", "direct", undefined],
] as const)("gives %s only its conversation under a legacy owner", async (_, chatType, owner) => {
  mocks.kind = "legacy";
  const turn = rootTurn(chatType, owner);
  const { memoryAudience, release } = await resolveEmbeddedAttemptMemoryAudience(turn);
  expect(memoryAudience).toEqual({
    kind: "conversation",
    agentId: "main",
    sessionKey: turn.sessionKey,
    sessionId: turn.sessionId,
  });
  expect(promptHookContext(turn, memoryAudience).memoryAudience?.kind).toBe("conversation");
  release();
});

it.each([
  ["an absent row", "absent"],
  ["an expired generation", "expired"],
] as const)("denies %s under a legacy owner without holding a lease", async (_, kind) => {
  mocks.kind = "legacy";
  const turn = rootTurn("direct", true);
  if (kind === "absent") {
    fakeSessionOwner.rows.delete(turn.sessionKey);
  } else {
    fakeSessionOwner.rows.set(turn.sessionKey, { ...turn.row, lifecycleRevision: randomUUID() });
  }
  const resolved = await resolveEmbeddedAttemptMemoryAudience(turn);
  expect(resolved.memoryAudience).toBeUndefined();
  expect(promptHookContext(turn, resolved.memoryAudience)).toMatchObject({
    memoryAudience: undefined,
    assertMemoryAudienceCurrent: undefined,
  });
  expect(fakeSessionOwner.activeLeases).toBe(0);
  expect(mocks.info).toHaveBeenCalledWith(
    expect.stringContaining("changed while its memory audience was resolved"),
    expect.objectContaining({ kind: "unverified", sessionKey: turn.sessionKey }),
  );
});

it("keeps a delegated audience and its owner's custody", async () => {
  mocks.kind = "legacy";
  const turn = rootTurn("direct", true);
  const owner = await resolveEmbeddedAttemptMemoryAudience(turn);
  const delegated = await resolveEmbeddedAttemptMemoryAudience({
    ...turn,
    run: { senderIsOwner: false, memoryAudience: owner.memoryAudience },
  });
  expect(delegated.memoryAudience).toBe(owner.memoryAudience);
  delegated.release();
  expect(fakeSessionOwner.activeLeases).toBe(1);
  await expect(
    resolveEmbeddedAttemptMemoryAudience({
      ...turn,
      run: { memoryAudience: { kind: "owner-private", agentId: "main" } },
    }),
  ).rejects.toThrow("Embedded run memory audience must be host-minted.");
  owner.release();
});

it.each(["malformed", "stale", "unverified"] as const)(
  "denies %s lineage with the appropriate repair log",
  async (kind) => {
    mocks.kind = "native";
    const params = kind === "malformed" ? attempt : spawnedChildAttempt(kind);
    const resolved = await resolveEmbeddedAttemptMemoryAudience(params);
    expect(resolved.memoryAudience).toBeUndefined();
    expect(mocks.warn).toHaveBeenCalledTimes(kind === "stale" ? 1 : 0);
    if (kind === "stale") {
      const [message] = mocks.warn.mock.calls[0] as [string];
      expect(message).toContain(`session ${CHILD_KEY} has stale lineage`);
      expect(message).toContain("Respawn or recreate it from a current session");
    }
    if (kind === "malformed") {
      expect(fakeSessionOwner.workerReads).toEqual([]);
    }
    if (kind !== "stale") {
      expect(fakeSessionOwner.activeLeases).toBe(0);
    }
    if (kind === "unverified") {
      expect(mocks.info).toHaveBeenCalledWith(
        expect.stringContaining("could not verify the lineage"),
        expect.objectContaining({ kind: "unverified", sessionKey: CHILD_KEY }),
      );
    }
  },
);
