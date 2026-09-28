/**
 * Print one vendor's name and address -- the Vendor Master's Address column.
 *
 * Only the address goes to the printer, not the screen around it: a page of
 * its own is written into a hidden frame and printed from there, which also
 * keeps a popup blocker out of it (no new window is opened). All of it at 11px:
 * the name in bold, the address under it, line breaks as typed.
 */

/** Text made safe to write into the page. */
function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/**
 * @param {object} vendor
 * @param {string} vendor.name     printed first, in bold
 * @param {string} vendor.address  printed under it; its line breaks are kept
 */
export function printAddress({ name, address }) {
  const lines = String(address ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>&nbsp;</title>
<style>
  /* No page margin at all, so the browser has nowhere to print its own header
     and footer (the date, the page title, the web address, the page number).

     The address's place on the page is the body's padding instead: 40mm from
     the top and 120mm from the left, with only 10mm kept on the right. Not
     "margin: 40mm 120mm", which puts 120mm on BOTH sides -- 240mm of margin on
     a 210mm-wide A4 page leaves no room for the address at all. */
  @page { margin: 0; }
  body {
    font-family: Arial, Helvetica, sans-serif;
    font-size: 11px;
    color: #000;
    margin: 0;
    padding: 40mm 10mm 0 120mm;
  }
  .to { font-size: 11px; margin: 0 0 4px; }
  .name { font-size: 11px; font-weight: 700; margin: 0 0 4px; }
  .line { font-size: 11px; line-height: 1.45; margin: 0; }
</style>
</head>
<body>
  <p class="to">To,</p>
  ${name ? `<p class="name">${escapeHtml(name)}</p>` : ''}
  ${lines.map((line) => `<p class="line">${escapeHtml(line)}</p>`).join('\n  ')}
</body>
</html>`;

  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  Object.assign(frame.style, { position: 'fixed', right: '0', bottom: '0', width: '0', height: '0', border: '0' });
  document.body.appendChild(frame);

  const remove = () => frame.remove();
  frame.onload = () => {
    const win = frame.contentWindow;
    // Removed once the print dialog is done with it -- afterprint where the
    // browser sends it, and a timer as a backstop where it does not.
    win.addEventListener('afterprint', () => setTimeout(remove, 0));
    setTimeout(remove, 60_000);
    win.focus();
    win.print();
  };
  frame.srcdoc = html;
}
