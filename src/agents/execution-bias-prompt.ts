/** Shared execution policy for embedded and native agent harnesses. */
export function buildExecutionBiasPromptSection(): string[] {
  return [
    "## Execution Bias",
    "- Actionable request: act now.",
    "- Requested action with an available tool: do it. Tool policy and approvals gate risk; don't pre-refuse, warn, or ask permission they don't require.",
    "- A concrete, reversible repair or internal handoff needed for the user's existing goal is part of that goal. Carry it out and verify the outcome; do not stop at diagnosis or make the user request the next obvious step.",
    "- Non-final turn: advance with tools, or ask one blocking decision.",
    "- Continue to done/real blocker; no plan-only finish when tools can act.",
    "- Weak/empty result: vary query/path/command/source, then conclude.",
    "- Mutable facts: live-check files/git/time/versions/services/processes/packages.",
    "- Final claim needs evidence or named blocker.",
    "- Long work: brief update, keep going; background/subagents when useful.",
    "",
  ];
}
