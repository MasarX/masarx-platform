import { signingCopy } from "./i18n/strings";

export function signingDocument(nonce: string, language: keyof typeof signingCopy = "en"): string {
  const text = signingCopy[language];
  return `<!doctype html>
<html lang="${language}" dir="${language === "ar" ? "rtl" : "ltr"}">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${text.title}</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; background: #eef3f5; color: #162d36; font: 1rem/1.5 system-ui, sans-serif; }
  main { width: min(100% - 2rem, 34rem); margin: clamp(1rem, 8vh, 5rem) auto; background: #fff; padding: clamp(1rem, 5vw, 2rem); border-radius: .75rem; }
  h1 { margin: 0 0 .5rem; font-size: clamp(1.5rem, 5vw, 2rem); line-height: 1.2; }
  fieldset { border: 0; margin: 0; padding: 0; min-width: 0; }
  legend { font-weight: 700; padding: 0; }
  canvas { display: block; width: 100%; height: auto; border: 1px solid #627781; border-radius: .375rem; touch-action: none; }
  [aria-disabled="true"] { pointer-events: none; }
  button { min-height: 44px; padding: .5rem 1rem; margin-block-start: .75rem; margin-inline-end: .25rem; border-radius: .375rem; border: 1px solid #125269; background: #fff; color: #125269; font: inherit; font-weight: 600; }
  button[type="submit"] { background: #125269; color: #fff; }
  button:disabled { opacity: .65; }
  :focus-visible { outline: 3px solid #125269; outline-offset: 3px; }
</style>
<main>
  <h1 id="title">${text.title}</h1>
  <p>${text.description}</p>
  <form aria-labelledby="title">
    <fieldset disabled>
      <legend>${text.legend}</legend>
      <p id="instructions">${text.instructions}</p>
      <canvas width="480" height="192" tabindex="-1" role="application" aria-label="${text.pad}" aria-describedby="instructions" aria-disabled="true"></canvas>
      <button type="button" id="clear">${text.clear}</button>
      <button type="submit" disabled>${text.submit}</button>
    </fieldset>
  </form>
  <p role="status" id="status"
    data-unavailable="${text.unavailable}" data-drawing="${text.drawing}" data-paused="${text.paused}"
    data-cleared="${text.cleared}" data-sending="${text.sending}" data-ready="${text.ready}"
    data-received="${text.received}" data-expired="${text.expired}" data-failed="${text.failed}">${text.open}</p>
</main>
<script src="/delivery-signing.js" nonce="${nonce}" defer></script>
</html>`;
}
