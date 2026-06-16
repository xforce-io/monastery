// src/shell/language.ts — outward-text language policy (#76).
// The shell resolves ONE target language per repo (Store.repoLanguage) and injects a directive into every
// agent that produces outward GitHub text (maintainer reply/panel/spec, patcher PR body, reviewer findings).
// A light, NON-blocking heuristic (looksOffLanguage) only warns on OBVIOUS drift — draft PRs stay the real
// safety net (#76 non-goal: prevent obvious drift, don't hard-gate or detect every mixing boundary).

/** Fallback when no repo/global policy is configured (PROTOCOL: repo → defaults → this). */
export const DEFAULT_LANGUAGE = "en-US";

/** Human-readable name for the directive prose; unknown tags fall back to the raw code. */
function languageName(lang: string): string {
  const names: Record<string, string> = {
    "zh-CN": "Simplified Chinese (简体中文)",
    "zh-TW": "Traditional Chinese (繁體中文)",
    "en-US": "English",
    "en-GB": "English",
    "ja-JP": "Japanese (日本語)",
    "ko-KR": "Korean (한국어)",
  };
  return names[lang] ?? lang;
}

/**
 * The policy directive injected into an agent's context/persona. It governs OUTWARD text only and is
 * explicit about the carve-outs (identifiers/commits/branches/existing file language are NOT translated)
 * and the no-leak rule (internal reasoning must not reach the PR body). Phrased as judgment, not a lint.
 */
export function languageDirective(lang: string): string {
  const name = languageName(lang);
  return [
    `<language-policy lang="${lang}">`,
    `OUTWARD TEXT LANGUAGE: write ALL outward GitHub text in ${name} — issue comments, the status panel, the PR title and body, spec and proposal drafts, and any review finding that surfaces in a PR.`,
    `DO NOT translate: code identifiers, commit messages, branch names, or the existing language of files and code comments — leave those exactly as the repo's convention dictates.`,
    `NEVER leak internal reasoning, self-debate, or debugging chatter into outward text: the PR body is a clean author summary for a human reviewer, not a transcript of how you got there.`,
    `</language-policy>`,
  ].join("\n");
}

/** Strip code blocks, inline code, and URLs so the heuristic judges PROSE, not code/identifiers. */
function prose(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")   // fenced code blocks
    .replace(/`[^`]*`/g, " ")          // inline code
    .replace(/https?:\/\/\S+/g, " ");  // URLs
}

/** Count CJK (Han) characters — the signal for Chinese prose. */
function cjkCount(s: string): number {
  return (s.match(/[㐀-鿿]/g) ?? []).length;
}
/** Count Latin letters — the signal for English/Western prose. */
function latinCount(s: string): number {
  return (s.match(/[A-Za-z]/g) ?? []).length;
}
/**
 * Count letters from any non-Latin script that signals a non-English block: CJK Han (㐀-鿿), Korean Hangul
 * syllables (가-힣), and Japanese kana (぀-ヿ). #169: the old en-US guard counted ONLY Han, so a Korean or
 * Japanese summary (whose script is neither Han nor Latin) slipped through with cjk=0 and never flagged.
 */
function nonLatinCount(s: string): number {
  return (s.match(/[぀-ヿ㐀-鿿가-힣]/g) ?? []).length;
}

/**
 * Conservative, NON-blocking drift detector. Returns true only when a SUBSTANTIAL block of prose is almost
 * entirely in the wrong script for the target language. Short text, code-heavy text, and mixed text never
 * flag — false positives are worse than misses here (the directive is the real lever; this only leaves a
 * warn trail). Only zh-CN and en-US are actively guarded; any other target returns false (#76 non-goal:
 * don't try to detect every language boundary, just the obvious outward drift this issue named).
 */
export function looksOffLanguage(text: string, lang: string): boolean {
  const body = prose(text);
  const cjk = cjkCount(body);
  const latin = latinCount(body);
  const nonLatin = nonLatinCount(body);  // CJK Han + Hangul + kana (superset of cjk)
  const letters = latin + nonLatin;
  if (letters < 60) return false; // too little prose to judge confidently

  if (lang === "zh-CN" || lang === "zh-TW") {
    // Substantial prose with almost no Han characters → a non-Chinese block slipped into Chinese output.
    return cjk / letters < 0.1;
  }
  if (lang === "en-US" || lang === "en-GB") {
    // Substantial prose dominated by a non-Latin script (CJK/Hangul/kana) → a foreign block slipped into
    // English output. #169: counting all non-Latin scripts (not just Han) catches Korean/Japanese drift too.
    return nonLatin / letters > 0.5;
  }
  return false;
}
