import { expect, it } from "vitest";
import { buildAgentSystemPrompt } from "./system-prompt.js";

it("keeps reversible repairs and internal handoffs inside the existing goal", () => {
  const prompt = buildAgentSystemPrompt({ workspaceDir: "/tmp/openclaw" });

  expect(prompt).toContain(
    "A concrete, reversible repair or internal handoff needed for the user's existing goal is part of that goal.",
  );
  expect(prompt).toContain("do not stop at diagnosis");
  expect(prompt).toContain("## Promised Work");
});
