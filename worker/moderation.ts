export type ModerationResult = {
  allowed: boolean;
  reason?: "too_short" | "too_long" | "repetition" | "abuse" | "link_spam" | "exploit" | "secrets";
};

const abusiveWords = new Set(["fuck", "fucking", "fucker", "shit", "bitch", "cunt", "asshole"]);

/** Actionable security disclosure — reject rather than publish on the open feed. */
const exploitPatterns = [



  /\b(remote code execution|\brce\b).{0,80}\b(payload|exploit|poc|proof of concept)\b/i,
  /\b(exploit|payload|poc|proof of concept).{0,80}\b(remote code execution|\brce\b)\b/i,
  /\bsql\s*injection\b.{0,120}('?\s*or\s+'?1'?\s*=\s*'?1|union\s+select|drop\s+table)/i,
  /\b(union\s+select|;\s*drop\s+table)\b/i,
  /\bprivilege\s+escalation\b.{0,80}\b(exploit|payload|steps?|how to)\b/i,
  /\b(how to|steps to)\b.{0,60}\b(hack|exploit|breach|pwn)\b/i,
  /\b(curl|wget|nc|netcat|bash\s+-i|powershell\s+-enc)\b.{0,120}\b(reverse\s+shell|bind\s+shell|shell\b)/i,
  /\beval\s*\(\s*base64/i,
  /\b\/etc\/(?:passwd|shadow)\b/i,
  /\b(?:cmd\.exe|\/bin\/(?:ba)?sh)\b.{0,80}\b(?:payload|exploit|backdoor)\b/i,
];

const secretPatterns = [
  /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/,
  /\b(?:sk_live_|sk_test_|rk_live_|rk_test_)[a-zA-Z0-9]{16,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*['"]?[a-zA-Z0-9_\-]{20,}/i,
  /\bpassword\s*[:=]\s*['"][^'"]{6,}['"]/i,
  /\bBearer\s+[a-zA-Z0-9\-._~+/]+=*\b/,
];

export function moderateFeedback(title: string, body: string, maxBodyLength = 5_000): ModerationResult {
  const text = `${title} ${body}`.trim();
  if (text.length < 20) return { allowed: false, reason: "too_short" };
  if (title.length > 300 || body.length > maxBodyLength) return { allowed: false, reason: "too_long" };

  if (secretPatterns.some((pattern) => pattern.test(text))) return { allowed: false, reason: "secrets" };
  if (exploitPatterns.some((pattern) => pattern.test(text))) return { allowed: false, reason: "exploit" };

  const links = text.match(/https?:\/\/\S+/gi) ?? [];
  if (links.length > 5) return { allowed: false, reason: "link_spam" };
  if (/(.)\1{11,}/iu.test(text)) return { allowed: false, reason: "repetition" };

  const words = text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
  const counts = new Map<string, number>();
  for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
  const highestCount = Math.max(0, ...counts.values());
  const uniqueRatio = counts.size / Math.max(words.length, 1);
  if (highestCount >= Math.max(8, Math.ceil(words.length * 0.45)) || (words.length >= 30 && uniqueRatio < 0.12)) {
    return { allowed: false, reason: "repetition" };
  }

  const abuseCount = words.filter((word) => abusiveWords.has(word)).length;
  if (abuseCount >= 3 && (words.length <= 20 || abuseCount / words.length >= 0.15)) {
    return { allowed: false, reason: "abuse" };
  }

  return { allowed: true };
}
