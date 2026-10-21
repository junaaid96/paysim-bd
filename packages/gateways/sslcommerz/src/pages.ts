// Simulator-owned HTML: the mock hosted payment page and the auto-POST
// return form. Content is ours (SIMULATOR banner everywhere); only the
// gw.php path + SESSIONKEY param mirror the real gateway.

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const BANNER =
  '<div class="sim">' +
  'SIMULATOR — no real money moves here. Do not enter real card details.' +
  '</div>';

const STYLE =
  'body{font-family:Inter,system-ui,sans-serif;background:#f4f4f5;color:#18181b;margin:0;padding:0 1rem 2rem}' +
  '.sim{max-width:560px;margin:1.5rem auto 0;background:repeating-linear-gradient(45deg,#fbbf24 0 12px,#f59e0b 12px 24px);color:#000;padding:.6rem 1rem;font-weight:700;text-align:center;border-radius:12px 12px 0 0;font-size:13px}' +
  '.shell{max-width:560px;margin:0 auto;background:#fff;border:1px solid #e4e4e7;border-top:4px solid #1d4ed8;border-radius:0 0 14px 14px;padding:1.5rem;box-shadow:0 10px 30px rgba(0,0,0,.06)}' +
  'h1{color:#1d4ed8;margin-top:0;font-size:1.4rem}' +
  'button{background:#1d4ed8;color:#fff;border:0;border-radius:8px;padding:.65rem 1.2rem;font:inherit;font-weight:600;cursor:pointer}' +
  'button[value=fail],button[value=cancel]{background:#fff;color:#3f3f46;border:1px solid #d4d4d8}' +
  '.foot{max-width:560px;margin:1rem auto;text-align:center;font-size:12px;color:#71717a}';

function shell(title: string, body: string): string {
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>` +
    `<style>${STYLE}</style></head><body>` +
    `${BANNER}<main class="shell">${body}</main>` +
    '<div class="foot">PaySim BD sandbox simulator · not affiliated with any payment provider · by CodeJBorg</div>' +
    '</body></html>'
  );
}

export interface CheckoutPageInput {
  tranId: string;
  amount: string;
  currency: string;
  storeName: string;
  sessionkey: string;
  state: string;
  notice?: string;
}

export function checkoutPage(input: CheckoutPageInput): string {
  const terminal = input.state !== 'initiated';
  const buttons = terminal
    ? `<p><strong>Outcome: ${escapeHtml(input.state.toUpperCase())}.</strong> ` +
      'This session is closed; buttons are disabled in Phase 1 (replay arrives with scenarios in Phase 2).</p>'
    : ['success', 'fail', 'cancel']
        .map(
          (action) =>
            `<form method="POST" style="display:inline;margin-right:8px">` +
            `<input type="hidden" name="SESSIONKEY" value="${escapeHtml(input.sessionkey)}">` +
            `<button type="submit" name="action" value="${action}">` +
            `${action === 'success' ? 'Success' : action === 'fail' ? 'Fail' : 'Cancel'}` +
            '</button></form>',
        )
        .join('');
  return shell(
    'Simulated SSLCommerz checkout',
    `<h1>Simulated payment page</h1>` +
      `<p>Store: <strong>${escapeHtml(input.storeName)}</strong></p>` +
      `<p>Order: <code>${escapeHtml(input.tranId)}</code></p>` +
      `<p>Amount: <strong>${escapeHtml(input.amount)} ${escapeHtml(input.currency)}</strong></p>` +
      (input.notice ? `<p><em>${escapeHtml(input.notice)}</em></p>` : '') +
      buttons,
  );
}

export function autoPostForm(targetUrl: string, fields: Record<string, string>): string {
  const inputs = Object.entries(fields)
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`,
    )
    .join('');
  return shell(
    'Returning to merchant',
    '<h1>Returning to merchant…</h1>' +
      `<p>If you are not redirected, press the button.</p>` +
      `<form id="sim-return" method="POST" action="${escapeHtml(targetUrl)}">${inputs}` +
      '<button type="submit">Continue</button></form>' +
      '<script>document.getElementById("sim-return").submit();</script>',
  );
}

export function errorPage(title: string, message: string, statusCode: number): string {
  return shell(
    title,
    `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p>HTTP ${statusCode} — simulator mock page.</p>`,
  );
}
