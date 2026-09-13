(function () {
  "use strict";

  var script = document.currentScript;
  if (!script) return;

  var apiBase = script.dataset.api || new URL(script.src, window.location.href).origin;
  var site = (script.dataset.site || window.location.hostname).toLowerCase().replace(/^www\./, "");
  var limit = Math.min(Math.max(Number(script.dataset.limit) || 20, 1), 100);

  async function refresh() {
    var endpoint = apiBase + "/api/projects/" + encodeURIComponent(site) + "/feedback?status=open&limit=" + limit;
    var response = await fetch(endpoint, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error("Tanomind feedback request failed: " + response.status);
    var payload = await response.json();
    window.dispatchEvent(new CustomEvent("tanomind:feedback", { detail: payload }));
    return payload;
  }

  window.Tanomind = Object.assign(window.Tanomind || {}, { site: site, refresh: refresh });
  refresh().catch(function (error) {
    window.dispatchEvent(new CustomEvent("tanomind:error", { detail: error }));
  });
})();
