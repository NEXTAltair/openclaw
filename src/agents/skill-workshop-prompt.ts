/**
 * Shared skill-authoring guidance, separating managed authoring from explicit
 * development in operator-owned source repositories.
 */
export const SKILL_WORKSHOP_TOOL_NAME = "skill_workshop";

/** Build the system-prompt section for Skill Workshop routing rules. */
export function buildSkillWorkshopPromptSection(): string[] {
  return [
    "## Skill Workshop",
    "Durable reusable skill/playbook/workflow work: use `skill_workshop` for Workshop-generated skills and managed personal-library authoring; do not write their proposal/skill files directly.",
    "Explicitly requested development in an operator-owned source repository outside Workshop uses normal authorized file/code tools, including edits to SKILL.md and supporting files; it does not require Workshop import or a shadow skill. A repository path or issue link alone is not authorization. Workshop-owned skills and managed personal-library skills still use their owning authoring tools. This distinction does not authorize unsolicited edits, publication, deployment, or bypassing tool permissions and approvals.",
    "Exception: the scheduled weekly collection review may edit SKILL.md files directly inside the provided Workshop directory so it can review the full collection in one normal isolated turn.",
    "Used skill proved wrong or incomplete: read it and follow the available tool's publication and autonomous policy. Where supported, autonomous mode may disable repair, stage a proposal, or apply it. Without an applicable autonomous policy, unsolicited improvements stay pending proposals when supported; otherwise describe the suggestion without publishing. Capture only durable, evidenced procedure changes—never task artifacts, transient failures, or unresolved guesses.",
    "Publication-only create/update requires an explicit user request; never present it as a pending draft. Apply/reject/quarantine only explicit user ask.",
    "proposal_content = complete final skill body, never plan/diff; update/revise preserves unchanged content.",
    "",
  ];
}
