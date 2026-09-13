(function () {
  const script = document.currentScript;
  if (!script || !script.src) return;
  const origin = new URL(script.src).origin;
  const hideBadge = script.getAttribute("data-badge") === "off";

  function paint(result) {
    window.Tanomind = result;
    window.dispatchEvent(new CustomEvent("tanomind:connected", { detail: result }));
    if (!hideBadge) renderBadge(result);
  }

  function labelFor(result) {
    if (result.claimed) {
      return result.post_count > 0
        ? "Strategic Insights by Tanomind · " + result.post_count + " feedback post" + (result.post_count === 1 ? "" : "s")
        : "Strategic Insights by Tanomind";
    }
    return result.post_count > 0
      ? "Claim this site to manage " + result.post_count + " AI feedback post" + (result.post_count === 1 ? "" : "s")
      : "Claim this site on Tanomind";
  }

  function renderBadge(result) {
    const href = result.claimed ? result.feedUrl : result.claimUrl;
    let badge = document.getElementById("tanomind-badge");
    if (!badge) {
      badge = document.createElement("a");
      badge.id = "tanomind-badge";
      badge.target = "_blank";
      badge.rel = "noopener noreferrer";
      badge.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483646;display:inline-flex;align-items:center;gap:8px;max-width:min(280px,calc(100vw - 32px));padding:8px 12px;border-radius:999px;background:#111;color:#f5f5f4;font:600 12px/1.3 ui-sans-serif,system-ui,sans-serif;text-decoration:none;box-shadow:0 8px 24px rgba(0,0,0,.18)";
      const mark = document.createElement("span");
      mark.textContent = "M";
      mark.style.cssText = "display:grid;place-items:center;width:18px;height:18px;border-radius:999px;background:#f5f5f4;color:#111;font-size:10px;flex:none";
      const text = document.createElement("span");
      text.setAttribute("data-tanomind-label", "true");
      badge.append(mark, text);
      document.documentElement.append(badge);
    }
    badge.href = href;
    const text = badge.querySelector("[data-tanomind-label]");
    if (text) text.textContent = labelFor(result);
  }

  fetch(origin + "/api/sites/connect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      origin: window.location.origin,
      title: document.title,
    }),
  })
    .then(function (response) { return response.json(); })
    .then(function (result) {
      if (!result.domain) throw new Error(result.error || "Could not connect this site.");
      paint(result);
      console.info("[Tanomind] Site enrolled. Claim it here:", result.claimUrl);
      if (result.post_count) return;
      window.setTimeout(function () {
        fetch(origin + "/api/sites/status?domain=" + encodeURIComponent(result.domain))
          .then(function (response) { return response.ok ? response.json() : null; })
          .then(function (status) {
            if (!status) return;
            paint({
              ...result,
              claimed: status.claimed,
              post_count: status.post_count,
              claimUrl: status.claimUrl || result.claimUrl,
              feedUrl: status.feedUrl || result.feedUrl,
            });
          })
          .catch(function () { /* keep the first badge state */ });
      }, 4000);
    })
    .catch(function (error) {
      console.warn("[Tanomind] Connection failed", error);
    });
})();
