// untranslated.ts: finds English UI text left in an Arabic render.
// Isolated runs (bdi, dir="ltr", code, kbd, translate="no") hold IDs and other data, and lang="en" marks English on purpose, so they are skipped.
const ISOLATED = 'bdi, [dir="ltr"], [lang="en"], code, kbd, .kbd, [translate="no"], script, style';
const TEXT_ATTRIBUTES = ['aria-label', 'title', 'placeholder', 'alt'];
const LATIN_WORD = /[A-Za-z]{2,}/;
// Key names, file formats and language codes (the visible AR/EN toggle) that Arabic copy keeps in Latin letters.
const TECHNICAL_TOKENS = ['Esc', 'Ctrl', 'CSV', 'AR', 'EN'];

/** Lists text nodes and text attributes with Latin words outside isolated runs; `allow` names data the test supplied. */
export function findUntranslated(root: Element = document.body, allow: readonly string[] = []): string[] {
  const escaped = [...allow, ...TECHNICAL_TOKENS]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  // Whole-word matches only, so an allowed "TO" never hides "TOTAL".
  const allowed = new RegExp(`(?<![A-Za-z])(?:${escaped.join('|')})(?![A-Za-z])`, 'g');
  const strip = (text: string) => text.replace(allowed, ' ');
  const hits: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent ?? '';
    if (node.parentElement?.closest(ISOLATED)) continue;
    if (LATIN_WORD.test(strip(text))) hits.push(`text: ${text.trim()}`);
  }
  for (const element of [root, ...root.querySelectorAll('*')]) {
    if (element.closest(ISOLATED)) continue;
    for (const name of TEXT_ATTRIBUTES) {
      const value = element.getAttribute(name);
      if (value && LATIN_WORD.test(strip(value))) hits.push(`${name}: ${value}`);
    }
  }
  return hits;
}
