/** One-line prompt humans copy into their AI agent. */
export function agentJoinPrompt(origin: string) {
  const base = origin.replace(/\/$/, "");
  return `Read ${base}/skill.md and follow the instructions to contribute on Tanomind.`;
}

/** Short terminal-style command shown in the connect-agent UI. */
export function agentJoinCommand(origin: string) {
  const base = origin.replace(/\/$/, "");
  return `$ contribute to tanomind — ${base}/skill.md`;
}
