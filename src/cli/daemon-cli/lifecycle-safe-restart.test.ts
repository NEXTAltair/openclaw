// Safe gateway restart tests cover operator-facing acknowledgement copy.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestSafeGatewayRestartIfNeeded } from "./lifecycle-safe-restart.js";

const callGatewayCli = vi.hoisted(() => vi.fn());
const refreshLegacySystemdServiceMetadata = vi.hoisted(() =>
  vi.fn<(_env: NodeJS.ProcessEnv, timeoutMs?: number) => Promise<boolean>>(async () => false),
);
const resolveGatewayServiceMutationError = vi.hoisted(() => vi.fn<() => Error | null>(() => null));
const appendGatewayLifecycleAudit = vi.hoisted(() => vi.fn());
const runtimeError = vi.hoisted(() => vi.fn());
const runtimeLog = vi.hoisted(() => vi.fn());
const runtimeWriteJson = vi.hoisted(() => vi.fn());

vi.mock("../../gateway/call.js", () => ({
  callGatewayCli,
}));

vi.mock("../../daemon/systemd.js", () => ({
  refreshLegacySystemdServiceMetadata,
}));

vi.mock("../../infra/gateway-supervision.js", () => ({
  resolveGatewayServiceMutationError,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: {
    error: runtimeError,
    log: runtimeLog,
    writeJson: runtimeWriteJson,
  },
  writeRuntimeJson: (_runtime: unknown, payload: unknown) => runtimeWriteJson(payload),
}));

vi.mock("./lifecycle-audit.js", () => ({
  appendGatewayLifecycleAudit,
}));

describe("runSafeGatewayRestart", () => {
  beforeEach(() => {
    callGatewayCli.mockReset();
    appendGatewayLifecycleAudit.mockReset();
    refreshLegacySystemdServiceMetadata.mockReset().mockResolvedValue(false);
    resolveGatewayServiceMutationError.mockReset().mockReturnValue(null);
    runtimeError.mockReset();
    runtimeLog.mockReset();
    runtimeWriteJson.mockReset();
  });

  it("keeps skip-deferral RPC behavior when bounded metadata cleanup fails", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const { runSafeGatewayRestart } = await import("./lifecycle-safe-restart.js");
    refreshLegacySystemdServiceMetadata.mockRejectedValueOnce(
      new Error("systemd cleanup timed out"),
    );
    callGatewayCli.mockResolvedValueOnce({
      status: "scheduled",
      preflight: {
        safe: false,
        activeWork: {
          queueSize: 1,
          runningTasks: 0,
          activeRequests: 0,
          activeAgentRuns: 0,
          pendingReplies: 2,
          totalActive: 3,
        },
        blockers: [{ kind: "pending-replies", count: 2, message: "2 pending reply(ies)" }],
        summary: "restart deferred: 2 pending reply(ies)",
      },
      restart: { pid: 123 },
    });

    await expect(
      runSafeGatewayRestart({ json: true, safe: true, skipDeferral: true }),
    ).resolves.toBe(true);

    expect(callGatewayCli).toHaveBeenCalledWith({
      method: "gateway.restart.request",
      params: { reason: "gateway.restart.safe", skipDeferral: true },
      timeoutMs: 10_000,
    });
    expect(refreshLegacySystemdServiceMetadata).toHaveBeenCalledWith(process.env, 5_000);
    expect(runtimeError).toHaveBeenCalledWith(expect.stringContaining("systemd cleanup timed out"));
    expect(runtimeWriteJson).toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          "safe restart requested; gateway bypassing active-work deferral; " +
          "shutdown may still wait for pending replies to drain",
        result: "scheduled",
      }),
    );
  });

  const gatewayEnv = {
    OPENCLAW_SERVICE_KIND: "gateway",
    OPENCLAW_GATEWAY_SERVICE_PID: "4200",
  };

  it("does not override explicit non-safe lifecycle controls", async () => {
    await expect(requestSafeGatewayRestartIfNeeded({ force: true }, gatewayEnv)).resolves.toBe(
      undefined,
    );
    await expect(requestSafeGatewayRestartIfNeeded({ wait: "30s" }, gatewayEnv)).resolves.toBe(
      undefined,
    );
    await expect(
      requestSafeGatewayRestartIfNeeded({ skipDeferral: true }, gatewayEnv),
    ).resolves.toBe(undefined);
    expect(callGatewayCli).not.toHaveBeenCalled();
  });

  it("does not affect commands outside the gateway service", async () => {
    await expect(requestSafeGatewayRestartIfNeeded({}, {})).resolves.toBeUndefined();
    await expect(
      requestSafeGatewayRestartIfNeeded(
        {},
        { OPENCLAW_SERVICE_KIND: "gateway", OPENCLAW_GATEWAY_SERVICE_PID: "invalid" },
      ),
    ).resolves.toBeUndefined();
    expect(callGatewayCli).not.toHaveBeenCalled();
  });

  it("keeps the RPC restart while skipping ineligible service mutation", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    resolveGatewayServiceMutationError.mockReturnValueOnce(
      new Error("gateway lifecycle is managed by an external supervisor"),
    );
    const { runSafeGatewayRestart } = await import("./lifecycle-safe-restart.js");
    callGatewayCli.mockResolvedValueOnce({
      status: "scheduled",
      preflight: { blockers: [], summary: "safe to restart now" },
      restart: { pid: 123 },
    });

    await expect(runSafeGatewayRestart({ json: true, safe: true })).resolves.toBe(true);

    expect(refreshLegacySystemdServiceMetadata).not.toHaveBeenCalled();
    expect(callGatewayCli).toHaveBeenCalledOnce();
    expect(runtimeError).toHaveBeenCalledWith(expect.stringContaining("external supervisor"));
  });

  it("uses local admin device auth without resolving SecretRefs", async () => {
    callGatewayCli.mockResolvedValueOnce({
      status: "deferred",
      preflight: { blockers: [], summary: "restart deferred" },
      restart: { pid: 4200 },
    });

    await requestSafeGatewayRestartIfNeeded({}, gatewayEnv);

    expect(callGatewayCli).toHaveBeenCalledWith({
      method: "gateway.restart.request",
      params: { reason: "gateway.restart.safe" },
      timeoutMs: 10_000,
      useStoredDeviceAuth: true,
      requiredStoredDeviceAuthScopes: ["operator.admin"],
      ignoreEnvUrlOverride: true,
    });
  });
});
