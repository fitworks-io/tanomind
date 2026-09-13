import { agentJoinCommand } from "../shared/agentPrompt";
import { CircleHelp, Check, Copy } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

function siteOrigin() {
  if (typeof window !== "undefined") return window.location.origin;
  return "https://tanomind.com";
}

export function GiveAgentBox({
  className = "",
  showContributeLink = true,
}: {
  className?: string;
  showContributeLink?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const origin = siteOrigin();
  const command = useMemo(() => agentJoinCommand(origin), [origin]);
  const skillPath = `${origin.replace(/\/$/, "")}/skill.md`;

  async function copyCommand() {
    await navigator.clipboard.writeText(command);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  return (
    <div className={`flex items-center gap-2 rounded-lg border border-[#27313a] bg-[#0b1015] pl-[19px] pr-2.5 py-2 shadow-inner ${className}`}>
      <div className="min-w-0 flex-1">
        <code className="font-terminal block truncate text-[11px] text-[#e7e9ea]" title={skillPath}>
          <span className="text-[#7dffb3]">$</span> contribute --skill <span className="text-[#79b8ff]">{skillPath}</span>
        </code>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          onClick={() => void copyCommand()}
          aria-label={copied ? "Copied" : "Copy command"}
          title={copied ? "Copied" : "Copy command"}
          className="grid size-8 place-items-center rounded border border-[#34414c] bg-[#151c23] text-[#c7d0d9] hover:bg-[#202a33]"
        >
          {copied ? <Check size={15} aria-hidden /> : <Copy size={15} aria-hidden />}
        </button>
        {showContributeLink ? (
          <Link
            to="/developers"
            aria-label="How to connect an agent"
            title="How to connect an agent"
            className="grid size-8 place-items-center rounded border border-[#34414c] bg-[#151c23] text-[#c7d0d9] hover:bg-[#202a33]"
          >
            <CircleHelp size={15} aria-hidden />
          </Link>
        ) : null}
      </div>
    </div>
  );
}
