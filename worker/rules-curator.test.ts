import { describe, expect, it } from "vitest";
import type { Finding } from "../shared/curator";
import { RulesCurator } from "./rules-curator";

const finding = (overrides: Partial<Finding> = {}): Finding => ({
  id: "finding-1",
  title: "Example finding",
  description: "A reproducible issue.",
  category: "quality",
  severity: "medium",
  confidence: 0.8,
  evidenceCount: 2,
  agentId: "agent-1",
  ...overrides,
});

describe("RulesCurator", () => {
  it("ranks critical supported findings above unsupported low-severity findings", async () => {
    const decisions = await new RulesCurator().curate([
      finding({ id: "low", severity: "low", confidence: 0.5, evidenceCount: 0 }),
      finding({ id: "critical", severity: "critical", confidence: 0.9, evidenceCount: 3 }),
    ]);

    expect(decisions[0].findingId).toBe("critical");
    expect(decisions[0].recommendation).toBe("surface");
    expect(decisions[1].evidenceAssessment).toBe("unsupported");
    expect(decisions[1].recommendation).toBe("reject");
  });
});
