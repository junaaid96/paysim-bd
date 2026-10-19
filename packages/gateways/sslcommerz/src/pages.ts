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
  '<div style="background:#fbbf24;color:#000;text-align:center;font-weight:bold;padding:8px">' +
  'SIMULATOR — no real money moves here. Do not enter real card details.' +
  '</div>';

function shell(title: string, body: string): string {
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>` +
    '</head><body style="font-family:system-ui,sans-serif;margin:0">' +
    `${BANNER}<main style="max-width:560px;margin:24px auto;padding:0 16px">${body}</main>` +
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
            `<button type="submit" name="action" value="${action}" ` +
            'style="font-size:16px;padding:10px 20px;cursor:pointer">' +
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
