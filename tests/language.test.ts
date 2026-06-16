// tests/language.test.ts — outward-text language policy primitives (#76).
import { expect, test } from "vitest";
import { DEFAULT_LANGUAGE, languageDirective, looksOffLanguage } from "../src/shell/language.js";

// --- languageDirective: the instruction injected into any agent that writes outward GitHub text ---

test("languageDirective names the target language and what to write in it", () => {
  const d = languageDirective("zh-CN");
  expect(d).toContain("zh-CN");
  expect(d).toMatch(/简体中文|Simplified Chinese/);
  // it must scope the policy to outward GitHub text (PR body, comments, panels, spec).
  expect(d).toMatch(/PR body|pull request|outward/i);
});

test("languageDirective forbids translating identifiers/commits/branches and leaking internal reasoning", () => {
  const d = languageDirective("zh-CN");
  expect(d).toMatch(/identifier|commit|branch/i);   // these are NOT translated
  expect(d).toMatch(/internal|reasoning|debate|chatter/i); // never leak internal reasoning into outward text
});

test("DEFAULT_LANGUAGE is en-US", () => {
  expect(DEFAULT_LANGUAGE).toBe("en-US");
});

// --- looksOffLanguage: conservative non-blocking heuristic (only flags obvious drift) ---

test("zh-CN target: a long block of pure English prose is flagged as off-language", () => {
  const text =
    "This pull request refactors the authentication module to remove the legacy token cache. " +
    "It introduces a small in-memory store and wires it through the existing middleware chain. " +
    "Every public entry point keeps its previous signature so callers are unaffected by the change. " +
    "The accompanying tests cover both the happy path and the expiry edge case in detail.";
  expect(looksOffLanguage(text, "zh-CN")).toBe(true);
});

test("zh-CN target: Chinese prose is fine", () => {
  const text =
    "本次改动重写了鉴权模块，移除了遗留的令牌缓存，并引入一个轻量的内存存储。" +
    "所有对外入口的签名保持不变，调用方无需任何调整。新增的测试覆盖了正常路径与过期边界。";
  expect(looksOffLanguage(text, "zh-CN")).toBe(false);
});

test("zh-CN target: short text or code-heavy text is never flagged (no false positives)", () => {
  expect(looksOffLanguage("ok", "zh-CN")).toBe(false);
  expect(looksOffLanguage("修复了 #76", "zh-CN")).toBe(false);
  // a fenced code block of English/code must not trip the heuristic — code is not prose.
  const codey = "改动如下：\n```ts\nfunction parseConfig(input: string): Config { return JSON.parse(input); }\n```\n以上。";
  expect(looksOffLanguage(codey, "zh-CN")).toBe(false);
});

test("en-US target: English prose is fine; a long CJK block is flagged", () => {
  const english =
    "This change adds a layered language policy so every agent that writes outward GitHub text " +
    "receives the resolved target language, and a light non-blocking gate warns on obvious drift.";
  expect(looksOffLanguage(english, "en-US")).toBe(false);
  const chinese =
    "本次改动引入分层语言策略，让每一个产出对外文本的 agent 都拿到解析后的目标语言，" +
    "并加入一个非阻塞的轻量门控，在出现明显语言漂移时给出告警提示供人审。";
  expect(looksOffLanguage(chinese, "en-US")).toBe(true);
});

// #169: the en-US guard only counted Han vs Latin, so a Korean/Japanese block (whose script is neither)
// slipped through undetected — the exact monastery#168 incident. Non-Latin scripts must flag for en-US.
test("en-US target: a long Korean (Hangul) block is flagged as off-language (#169)", () => {
  const korean =
    "이 변경은 품질 게이트의 사각지대를 수정합니다. 좁은 테스트 하위 집합에서 패처가 새로 작성한 " +
    "테스트가 실행되지 않아 게이트가 거짓 통과를 반환하는 문제를 해결합니다. 이제 패치에 포함된 " +
    "테스트 파일은 감지된 러너로 명시적으로 다시 실행되므로 거짓 통과가 사라집니다.";
  expect(looksOffLanguage(korean, "en-US")).toBe(true);
});

test("en-US target: a long Japanese (kana) block is flagged as off-language (#169)", () => {
  const japanese =
    "この変更は品質ゲートの盲点を修正します。狭いテストサブセットではパッチャが新しく書いた" +
    "テストが実行されず、ゲートが誤った緑を返していました。これからはパッチに含まれるテスト" +
    "ファイルが検出されたランナーで明示的に再実行されるため、誤った緑がなくなります。";
  expect(looksOffLanguage(japanese, "en-US")).toBe(true);
});
