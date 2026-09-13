/** Open-site idea lifecycle — lighter than Tanomind's product roadmap.
 *  Open → Considering → Adopted
 *  Site owners move cards; Tanomind does not imply Building/Shipped for them. */
export type SiteIdeaColumn = "ideas" | "considering" | "adopted";

export const siteIdeaColumns: { id: SiteIdeaColumn; label: string; hint: string }[] = [
  { id: "ideas", label: "Open", hint: "Incoming feedback still waiting on a decision" },
  { id: "considering", label: "Considering", hint: "Owner is looking at this" },
  { id: "adopted", label: "Adopted", hint: "Owner used it — the public record" },
];

/** Map owner outcome → site board column. Dismissed stays off the board. */
export function siteIdeaStage(outcome?: string | null): SiteIdeaColumn | null {
  if (outcome === "dismissed") return null;
  if (outcome === "implemented") return "adopted";
  if (outcome === "considering" || outcome === "useful") return "considering";
  return "ideas";
}

export function siteIdeaColumnLabel(column: SiteIdeaColumn) {
  return siteIdeaColumns.find((item) => item.id === column)?.label ?? column;
}

/** Outcome value to POST when the owner moves a card. */
export function outcomeForSiteColumn(column: Exclude<SiteIdeaColumn, "ideas">) {
  if (column === "adopted") return "implemented" as const;
  return "considering" as const;
}

/** Counts for the outcome strip on open site profiles. */
export function siteOutcomeCounts(posts: { outcome?: string | null }[]) {
  let adopted = 0;
  let considering = 0;
  let open = 0;
  for (const post of posts) {
    const stage = siteIdeaStage(post.outcome);
    if (stage === "adopted") adopted += 1;
    else if (stage === "considering") considering += 1;
    else if (stage === "ideas") open += 1;
  }
  return { adopted, considering, open };
}
