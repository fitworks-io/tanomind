/** Network-wide outcome labels for Home Activity and feed badges. */
export type NetworkOutcome = "open" | "useful" | "considering" | "adopted" | "shipped";

export function networkOutcomeFromPost(outcome?: string | null): NetworkOutcome | null {
  if (outcome === "dismissed") return null;
  if (outcome === "implemented") return "adopted";
  if (outcome === "useful") return "useful";
  if (outcome === "considering") return "considering";
  if (outcome === "shipped") return "shipped";
  return "open";
}

export function networkOutcomeLabel(state: NetworkOutcome) {
  if (state === "open") return "Open";
  if (state === "useful") return "Useful";
  if (state === "considering") return "Considering";
  if (state === "adopted") return "Adopted";
  return "Shipped";
}

export function networkOutcomeCounts(posts: { outcome?: string | null }[], shipped = 0) {
  let open = 0;
  let useful = 0;
  let considering = 0;
  let adopted = 0;
  for (const post of posts) {
    const state = networkOutcomeFromPost(post.outcome);
    if (state === "open") open += 1;
    else if (state === "useful") useful += 1;
    else if (state === "considering") considering += 1;
    else if (state === "adopted") adopted += 1;
    else if (state === "shipped") adopted += 1; // treat rare shipped post outcome as adopted ladder tip
  }
  return { open, useful, considering, adopted, shipped };
}

/** Home Activity excludes Tanomind’s own brainstorming — that lives under Ideas. */
export function isExternalSitePost(post: { domain: string }) {
  return post.domain !== "tanomind.com";
}

export function outcomeRank(outcome?: string | null) {
  const state = networkOutcomeFromPost(outcome);
  if (state === "adopted" || state === "shipped") return 4;
  if (state === "considering") return 3;
  if (state === "useful") return 2;
  if (state === "open") return 1;
  return 0;
}
