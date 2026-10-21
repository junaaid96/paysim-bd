// Mock Nagad payment page + post-action redirect page. Plain HTML, no
// gateway assets. The redirect page mirrors the community flow: the
// customer browser follows a GET redirect to the merchant callback URL.

export function escapeHtml(input: string): string {
  return String(input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Only http(s) targets may be navigated to (blocks javascript:/data: URLs). */
export function safeHttpUrl(input: string): string {
  return /^https?:\/\//i.test(input.trim()) ? input.trim() : 'about:blank';
}

function shell(title: string, inner: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${escapeHtml(title)}</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:Inter,system-ui,sans-serif;background:#f4f4f5;color:#18181b;margin:0;padding:0 1rem 2rem}.sim{max-width:560px;margin:1.5rem auto 0;background:repeating-linear-gradient(45deg,#fbbf24 0 12px,#f59e0b 12px 24px);color:#000;padding:.6rem 1rem;font-weight:700;text-align:center;border-radius:12px 12px 0 0;font-size:13px}.shell{max-width:560px;margin:0 auto;background:#fff;border:1px solid #e4e4e7;border-top:4px solid #ec5a24;border-radius:0 0 14px 14px;padding:1.5rem;box-shadow:0 10px 30px rgba(0,0,0,.06)}h1,h2{color:#ec5a24;margin-top:0}input{padding:.55rem .7rem;border:1px solid #d4d4d8;border-radius:8px;font:inherit}button{background:#ec5a24;color:#fff;border:0;border-radius:8px;padding:.6rem 1.1rem;font-weight:600;cursor:pointer;margin:.25rem .25rem .25rem 0;font:inherit;font-weight:600}button[value=fail],button[value=cancel]{background:#fff;color:#3f3f46;border:1px solid #d4d4d8}.foot{max-width:560px;margin:1rem auto;text-align:center;font-size:12px;color:#71717a}</style></head>
<body>
<div class="sim">SIMULATOR — fake money, no real wallet is touched</div>
<div class="shell">
${inner}
</div>
<div class="foot">PaySim BD sandbox simulator · not affiliated with any payment provider · by CodeJBorg</div>
</body>
</html>`;
}

export interface CheckoutPageInput {
  paymentRefId: string;
  amount: string;
  orderId: string;
  appName: string;
  state: string;
  notice?: string;
}

export function checkoutPage(input: CheckoutPageInput): string {
  const buttons = (['success', 'fail', 'cancel'] as const)
    .map(
      (action) =>
        `<button type="submit" name="action" value="${action}" style="margin-right: 0.5rem; padding: 0.5rem 1rem;">${action === 'success' ? 'Approve payment' : action === 'fail' ? 'Fail payment' : 'Cancel'}</button>`,
    )
    .join('\n');
  return shell(
    'Nagad checkout (simulator)',
    `<h1>Nagad checkout (simulator)</h1>
<p>Merchant: <strong>${escapeHtml(String(input.appName))}</strong></p>
<p>Order: <code>${escapeHtml(String(input.orderId))}</code></p>
<p>Amount: <strong>${escapeHtml(String(input.amount))} BDT</strong></p>
<p>Payment ref: <code>${escapeHtml(String(input.paymentRefId))}</code></p>
<p>State: <code>${escapeHtml(String(input.state))}</code></p>
${input.notice ? `<p><em>${escapeHtml(input.notice)}</em></p>` : ''}
<form method="POST">
<input type="hidden" name="paymentRefId" value="${escapeHtml(String(input.paymentRefId))}">
${buttons}
</form>
<p><small>Wallet / OTP / PIN entry is theater in the simulator: pick an outcome above.</small></p>`,
  );
}

export interface RedirectPageInput {
  status: 'Success' | 'Fail' | 'Cancel';
  paymentRefId: string;
  targetUrl: string;
}

export function redirectPage(input: RedirectPageInput): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${escapeHtml(safeHttpUrl(input.targetUrl))}"><title>Returning to merchant…</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:Inter,system-ui,sans-serif;background:#f4f4f5;color:#18181b;margin:0;padding:0 1rem 2rem}.sim{max-width:560px;margin:1.5rem auto 0;background:repeating-linear-gradient(45deg,#fbbf24 0 12px,#f59e0b 12px 24px);color:#000;padding:.6rem 1rem;font-weight:700;text-align:center;border-radius:12px 12px 0 0;font-size:13px}.shell{max-width:560px;margin:0 auto;background:#fff;border:1px solid #e4e4e7;border-top:4px solid #ec5a24;border-radius:0 0 14px 14px;padding:1.5rem;box-shadow:0 10px 30px rgba(0,0,0,.06)}h1,h2{color:#ec5a24;margin-top:0}input{padding:.55rem .7rem;border:1px solid #d4d4d8;border-radius:8px;font:inherit}button{background:#ec5a24;color:#fff;border:0;border-radius:8px;padding:.6rem 1.1rem;font-weight:600;cursor:pointer;margin:.25rem .25rem .25rem 0;font:inherit;font-weight:600}button[value=fail],button[value=cancel]{background:#fff;color:#3f3f46;border:1px solid #d4d4d8}.foot{max-width:560px;margin:1rem auto;text-align:center;font-size:12px;color:#71717a}</style></head>
<body>
<div class="sim">SIMULATOR</div>
<div class="shell">
<h1>Payment ${escapeHtml(String(input.status))}</h1>
<p>Payment ref: <code>${escapeHtml(String(input.paymentRefId))}</code></p>
<p>Continuing to the merchant…</p>
<p><a id="continue" href="${escapeHtml(safeHttpUrl(input.targetUrl))}">Continue to merchant</a></p>
</div>
<div class="foot">PaySim BD sandbox simulator · not affiliated with any payment provider · by CodeJBorg</div>
</body>
</html>`;
}

export function errorPage(title: string, message: string, status: number): string {
  return shell(
    title,
    `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p>Status: ${status}</p>`,
  );
}
