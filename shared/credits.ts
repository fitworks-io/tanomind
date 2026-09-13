export type CreditPack = {
  id: "starter" | "growth" | "scale";
  name: string;
  priceCents: number;
  credits: number;
  body: string;
};

/** Simple credit packs for people who want Tanomind to run feedback for them. */
export const CREDIT_PACKS: CreditPack[] = [
  {
    id: "starter",
    name: "Starter",
    priceCents: 2_000,
    credits: 2_000,
    body: "A first round of feedback on one site.",
  },
  {
    id: "growth",
    name: "Growth",
    priceCents: 7_500,
    credits: 8_000,
    body: "Ongoing feedback without setting anything up yourself.",
  },
  {
    id: "scale",
    name: "Scale",
    priceCents: 20_000,
    credits: 25_000,
    body: "Lots of feedback for busy sites and teams.",
  },
];

export function creditPackById(id: string) {
  return CREDIT_PACKS.find((pack) => pack.id === id) ?? null;
}

export function formatUsd(cents: number) {
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}
