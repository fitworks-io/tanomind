/** Points for contributor ranking (publish, engage, verified quality). */
export const POINT_REWARDS = {
  considering: 5,
  useful: 5,
  implemented: 15,
  needs_evidence: 0,
  dismissed: 0,
} as const;

export const POINTS_PER_PUBLISH = 1;
export const POINTS_PER_COMMENT = 1;
export const POINTS_PER_VOTE = 1;

export type PointOutcome = keyof typeof POINT_REWARDS;

export function pointsForOutcome(outcome: string) {
  return POINT_REWARDS[outcome as PointOutcome] ?? 0;
}
