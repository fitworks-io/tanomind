export type Sponsor = {
  name: string;
  domain: string;
  href: string;
  tag: string;
  internal?: boolean;
};

export type SponsorSlotStatus = "taken" | "open" | "reserved";

export type SponsorSlot = {
  id: string;
  side: "left" | "right";
  position: number;
  occupant?: string;
  status: SponsorSlotStatus;
  note?: string;
};

/** Demo / placeholder sponsor slots (pattern from canivibecodeit.com). */
export const sponsors: Sponsor[] = [
  {
    name: "WishKit",
    domain: "wishkit.io",
    href: "https://www.wishkit.io/saas-feedback-board?ref=tanomind&utm_source=tanomind&utm_medium=referral&utm_campaign=sponsor_card",
    tag: "SaaS feedback board. Build what sells.",
  },
  {
    name: "Postiz",
    domain: "postiz.com",
    href: "https://postiz.com/?utm_source=tanomind&utm_medium=referral&utm_campaign=sponsor_card",
    tag: "Schedule and publish across social.",
  },
  {
    name: "Plausible",
    domain: "plausible.io",
    href: "https://plausible.io/?utm_source=tanomind&utm_medium=referral&utm_campaign=sponsor_card",
    tag: "Privacy-friendly website analytics.",
  },
  {
    name: "Resend",
    domain: "resend.com",
    href: "https://resend.com/?utm_source=tanomind&utm_medium=referral&utm_campaign=sponsor_card",
    tag: "Email API for product teams.",
  },
  {
    name: "Bullseye",
    domain: "bullseye.so",
    href: "https://www.bullseye.so/?utm_source=tanomind&utm_medium=referral&utm_campaign=sponsor_card",
    tag: "Find high-intent leads for your product.",
  },
];

export const sponsorPrice = 2500;
export const sponsorTermDays = 30;
export const sponsorContactEmail = "hello@tanomind.com";

/** Ten fixed rail slots — same layout as canivibecodeit.com/sponsor. */
export const sponsorSlots: SponsorSlot[] = [
  { id: "L1", side: "left", position: 1, occupant: "WishKit", status: "reserved", note: "Reserved" },
  { id: "L2", side: "left", position: 2, status: "open", note: "Open · $2,500" },
  { id: "L3", side: "left", position: 3, occupant: "Postiz", status: "taken" },
  { id: "L4", side: "left", position: 4, occupant: "Plausible", status: "taken" },
  { id: "L5", side: "left", position: 5, occupant: "Bullseye", status: "taken" },
  { id: "R1", side: "right", position: 1, occupant: "Resend", status: "taken" },
  { id: "R2", side: "right", position: 2, status: "open", note: "Open · $2,500" },
  { id: "R3", side: "right", position: 3, status: "open", note: "Open · $2,500" },
  { id: "R4", side: "right", position: 4, status: "open", note: "Open · $2,500" },
  { id: "R5", side: "right", position: 5, status: "open", note: "Open · $2,500" },
];

export function sponsorSlotMailto(slot: SponsorSlot) {
  const subject = encodeURIComponent(`Sponsor slot ${slot.id} on tanomind.com`);
  const body = encodeURIComponent(`Hi — I'd like to sponsor slot ${slot.id} (${slot.side} rail) on Tanomind.\n\nCompany:\nOne-line tag:\nLink:\n`);
  return `mailto:${sponsorContactEmail}?subject=${subject}&body=${body}`;
}

export function sponsorFavicon(domain: string) {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;
}

export const sponsorTints = [
  "51, 230, 103",
  "183, 138, 42",
  "230, 206, 51",
  "120, 180, 255",
  "255, 140, 90",
] as const;

export function sponsorsForSide(side: "left" | "right") {
  const split = Math.ceil(sponsors.length / 2);
  return side === "left" ? sponsors.slice(0, split) : sponsors.slice(split);
}
