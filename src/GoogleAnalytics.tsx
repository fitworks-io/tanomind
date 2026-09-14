import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";

const MEASUREMENT_ID = "G-V5YSYGYS2X";
const CONSENT_KEY = "tanomind-analytics-consent";

declare global {
  interface Window {
    dataLayer: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

function loadGoogleAnalytics() {
  if (document.querySelector(`script[data-tanomind-analytics="${MEASUREMENT_ID}"]`)) return;

  window.dataLayer = window.dataLayer || [];
  window.gtag = (...args: unknown[]) => window.dataLayer.push(args);
  window.gtag("js", new Date());
  window.gtag("config", MEASUREMENT_ID, { send_page_view: false });

  const script = document.createElement("script");
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${MEASUREMENT_ID}`;
  script.dataset.tanomindAnalytics = MEASUREMENT_ID;
  document.head.appendChild(script);
}

export function GoogleAnalytics() {
  const location = useLocation();
  const [consent, setConsent] = useState<"accepted" | "declined" | null>(() => {
    const saved = localStorage.getItem(CONSENT_KEY);
    return saved === "accepted" || saved === "declined" ? saved : null;
  });

  useEffect(() => {
    if (consent === "accepted") loadGoogleAnalytics();
  }, [consent]);

  useEffect(() => {
    if (consent !== "accepted" || !window.gtag) return;
    window.gtag("event", "page_view", {
      page_location: window.location.href,
      page_path: `${location.pathname}${location.search}`,
      page_title: document.title,
    });
  }, [consent, location.pathname, location.search]);

  const choose = (value: "accepted" | "declined") => {
    localStorage.setItem(CONSENT_KEY, value);
    setConsent(value);
  };

  if (consent) return null;

  return (
    <aside className="fixed inset-x-3 bottom-3 z-[100] mx-auto flex max-w-xl flex-col gap-3 rounded-xl border border-edge bg-paper p-4 text-sm text-ink shadow-lg sm:flex-row sm:items-center">
      <p className="flex-1 text-stone">
        Allow anonymous analytics to help improve Tanomind? See our <a className="underline" href="/privacy">Privacy Policy</a>.
      </p>
      <div className="flex shrink-0 gap-2">
        <button className="rounded-full border border-edge px-4 py-2 font-semibold" onClick={() => choose("declined")}>Decline</button>
        <button className="rounded-full bg-ink px-4 py-2 font-semibold text-paper" onClick={() => choose("accepted")}>Allow</button>
      </div>
    </aside>
  );
}
