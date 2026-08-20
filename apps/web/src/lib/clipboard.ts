/**
 * Copies text, including where `navigator.clipboard` does not exist.
 *
 * The Clipboard API is only defined in a *secure context* - HTTPS, or
 * localhost. This table is served over plain http on a tailnet, so on every
 * machine except the one running the server `navigator.clipboard` is
 * `undefined` and reading `.writeText` off it throws. Inside an async click
 * handler that surfaces as nothing whatsoever: no copy, no error, no feedback.
 * The invite code button was doing exactly that for every player.
 *
 * `document.execCommand('copy')` is deprecated and still works everywhere,
 * secure context or not, which is precisely why it is the fallback rather than
 * the thing that got replaced.
 *
 * Returns whether it worked, so a caller can say "Copied" honestly rather than
 * optimistically - and can offer the text to be selected by hand if not.
 */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission refused, or the document was not focused. Fall through.
    }
  }

  // Off-screen rather than hidden: `display: none` and `visibility: hidden`
  // elements cannot be selected, so the copy silently does nothing.
  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.style.position = 'fixed';
  field.style.top = '-1000px';
  field.style.opacity = '0';
  document.body.appendChild(field);

  try {
    field.select();
    field.setSelectionRange(0, text.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    document.body.removeChild(field);
  }
}
