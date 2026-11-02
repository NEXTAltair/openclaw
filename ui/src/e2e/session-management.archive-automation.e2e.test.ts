import { expect, it } from "vitest";
import type { CronJob } from "../api/types.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { cronListResponseFixture } from "../test-helpers/cron.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import * as ui from "./session-management.compact.test-support.ts";
import {
  captureUiProof,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

const job: CronJob = {
  id: "nightly-digest",
  name: "Nightly digest",
  enabled: true,
  createdAtMs: 1,
  updatedAtMs: 1,
  schedule: { kind: "every", everyMs: 86_400_000 },
  sessionTarget: "isolated",
  wakeMode: "now",
  payload: { kind: "agentTurn", message: "Summarize the day." },
  state: {},
};

suite.define(() => {
  it.each(["sidebar", "list"] as const)(
    "archives a conversation with automations without a pause warning from the %s",
    (surface) =>
      suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        const main = sessionRow("agent:main:main", "Main", 1);
        const target = sessionRow("agent:main:nightly", "Nightly owner", 2, {
          hasAutomation: true,
        });
        const gateway = await ui.installSessionRows(page, [main, target], {
          sessionKey: main.key,
          sessionArchiveFiltering: true,
          methodResponses: {
            "cron.list": cronListResponseFixture({
              jobs: [job],
              snapshotRevision: "archive-automation-1",
              total: 1,
              limit: 10,
              offset: 0,
              nextOffset: null,
              hasMore: false,
            }),
          },
        });
        await page.goto(
          surface === "list"
            ? suite.server.baseUrl + "sessions"
            : controlUiSessionUrl(suite.server.baseUrl, main.key),
        );
        const row =
          surface === "list"
            ? page.locator(".session-data-row").filter({ hasText: target.label })
            : page.locator('.sidebar-recent-session[data-session-key="' + target.key + '"]');
        await ui.visible(row);

        await ui.archiveSession(page, row, surface);
        const patch = await ui.sessionPatch(gateway, target.key, { archived: true });
        expect(patch.params).toMatchObject({
          key: target.key,
          expectedSessionId: target.sessionId,
          archived: true,
        });
        expect(await page.locator("openclaw-modal-dialog dialog[open]").count()).toBe(0);
        expect(
          (await gateway.getRequests("cron.list")).filter(
            ({ params }) =>
              (params as { sessionKey?: string; compact?: boolean } | undefined)?.sessionKey ===
                target.key && (params as { compact?: boolean } | undefined)?.compact === true,
          ),
        ).toEqual([]);
        await captureUiProof(suite, page, "archive-without-automation-warning-" + surface + ".png");
      }),
  );

  it("archives a conversation without automations with no confirmation", () =>
    suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const main = sessionRow("agent:main:main", "Main", 1);
      const target = sessionRow("agent:main:plain", "Plain conversation", 2);
      const gateway = await ui.installSessionRows(page, [main, target], {
        sessionKey: main.key,
        sessionArchiveFiltering: true,
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, main.key));
      const row = page.locator('.sidebar-recent-session[data-session-key="' + target.key + '"]');
      await ui.visible(row);
      await ui.archiveSession(page, row, "sidebar");
      await ui.sessionPatch(gateway, target.key, { archived: true });
      // Other surfaces may list automations; the archive itself never asks about this row.
      expect(
        (await gateway.getRequests("cron.list")).filter(
          ({ params }) =>
            (params as { sessionKey?: string } | undefined)?.sessionKey === target.key,
        ),
      ).toEqual([]);
      expect(await page.locator("openclaw-modal-dialog dialog[open]").count()).toBe(0);
    }));
});
