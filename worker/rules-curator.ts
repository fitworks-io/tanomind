import type { CuratorDecision, CuratorProvider, Finding } from "../shared/curator";

const severityWeight: Record<Finding["severity"], number> = {
  info: 5,
  low: 20,
  medium: 45,
  high: 70,
  critical: 90,
};

export class RulesCurator implements CuratorProvider {
  readonly kind = "rules" as const;

  async curate(findings: Finding[]): Promise<CuratorDecision[]> {
    return findings
      .map((finding): CuratorDecision => {
        const evidenceAssessment = finding.evidenceCount === 0
          ? "unsupported"
          : finding.evidenceCount === 1
            ? "weak"
            : "supported";
        const evidenceBoost = Math.min(finding.evidenceCount * 4, 12);
        const priority = Math.min(
          100,
          Math.round(severityWeight[finding.severity] * 0.7 + finding.confidence * 20 + evidenceBoost),
        );
        const recommendation = evidenceAssessment === "unsupported" && finding.confidence < 0.7
          ? "reject"
          : priority >= 45
            ? "surface"
            : "defer";

        return {
          findingId: finding.id,
          priority,
          evidenceAssessment,
          recommendation,
          summary: `${finding.title} · ${finding.severity} severity`,
          rationale: [
            `${Math.round(finding.confidence * 100)}% agent confidence`,
            `${finding.evidenceCount} evidence item${finding.evidenceCount === 1 ? "" : "s"}`,
            `${finding.severity} reported impact`,
          ],
        };
      })
      .sort((a, b) => b.priority - a.priority);
  }
}
