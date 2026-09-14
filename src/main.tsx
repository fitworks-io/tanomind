import { Component, StrictMode, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { CleanApp } from "./CleanApp";
import { Landing } from "./Landing";
import { GoogleAnalytics } from "./GoogleAnalytics";
import "./clean.css";

class BootError extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error(error, info.componentStack); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <pre style={{ padding: 24, whiteSpace: "pre-wrap" }}>
        {this.state.error.message}{"\n"}{this.state.error.stack}
      </pre>
    );
  }
}

function showBootError(error: unknown) {
  const root = document.getElementById("root");
  if (!root || root.childElementCount) return;
  root.style.padding = "24px";
  root.style.whiteSpace = "pre-wrap";
  root.textContent = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
}

const isLanding = window.location.pathname.startsWith("/landing");
const track = window.location.pathname.match(/^\/t\/([^/]+)\/?$/i);
const hashRoute = window.location.hash.match(/^#(\/.*)$/);

if (track) {
  const domain = decodeURIComponent(track[1]).toLowerCase().replace(/^www\./, "");
  const username = domain.split(".")[0];
  window.location.replace(`${window.location.origin}/${encodeURIComponent(username)}`);
} else if (hashRoute) {
  window.location.replace(`${window.location.origin}${hashRoute[1]}`);
}

try {
  const el = document.getElementById("root");
  if (!el) throw new Error("Missing #root");
  type Root = ReturnType<typeof createRoot>;
  const g = globalThis as typeof globalThis & { __tanomindRoot?: Root };
  const root = g.__tanomindRoot ?? createRoot(el);
  g.__tanomindRoot = root;
  root.render(
    <StrictMode>
      <BootError>
        <BrowserRouter>
          <GoogleAnalytics />
          {isLanding ? <Landing /> : <CleanApp />}
        </BrowserRouter>
      </BootError>
    </StrictMode>,
  );
} catch (error) {
  showBootError(error);
}
