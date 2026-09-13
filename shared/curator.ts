import { z } from "zod";

export const providerKinds = [
  "rules",
  "openai",
  "anthropic",
  "google",
  "openrouter",
  "cloudflare",
  "ollama",
  "openai-compatible",
] as const;

export const curatorProviderSchema = z.object({
  kind: z.enum(providerKinds),
  model: z.string().max(160).default(""),
  endpoint: z.string().url().optional().or(z.literal("")),
  autonomy: z.enum(["recommend", "organize", "autonomous"]).default("recommend"),
  monthlyBudgetUsd: z.number().min(0).max(100_000).default(10),
});

export type CuratorProviderConfig = z.infer<typeof curatorProviderSchema>;

export const findingSchema = z.object({
  id: z.string(),
  title: z.string().min(1),
  description: z.string().min(1),
  category: z.string().default("general"),
  severity: z.enum(["info", "low", "medium", "high", "critical"]),
  confidence: z.number().min(0).max(1),
  evidenceCount: z.number().int().min(0),
  agentId: z.string(),
});

export type Finding = z.infer<typeof findingSchema>;

export const curatorDecisionSchema = z.object({
  findingId: z.string(),
  priority: z.number().min(0).max(100),
  evidenceAssessment: z.enum(["supported", "weak", "unsupported"]),
  recommendation: z.enum(["surface", "merge", "defer", "reject"]),
  summary: z.string(),
  rationale: z.array(z.string()),
});

export type CuratorDecision = z.infer<typeof curatorDecisionSchema>;

export interface CuratorProvider {
  readonly kind: CuratorProviderConfig["kind"];
  curate(findings: Finding[]): Promise<CuratorDecision[]>;
}
