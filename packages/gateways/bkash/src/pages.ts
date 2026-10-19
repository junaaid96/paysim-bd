// Mock bKash payment page + post-action redirect page. Plain HTML, no
// gateway assets. The redirect page mirrors the real flow: the customer
// browser follows a GET redirect to the merchant callback URL.

function shell(title: string, inner: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${title}</title></head>
<body style="font-family: sans-serif; max-width: 560px; margin: 2rem auto; padding: 0 1rem;">
<div style="background: #fbbf24; color: #000; padding: 0.5rem 1rem; font-weight: bold; text-align: center;">SIMULATOR — fake money, no real wallet is touched</div>
${inner}
</body>
</html>`;
}

export interface CheckoutPageInput {
  paymentId: string;
  amount: string;
  currency: string;
  invoice: string;
  appName: string;
  state: string;
  notice?: string;
}

export function checkoutPage(input: CheckoutPageInput): string {
  const buttons = (['success', 'fail', 'cancel'] as const)
    .map(
      (action) =>
        `<button type="submit" name="action" value="${action}" style="margin-right: 0.5rem; padding: 0.5rem 1rem;">${action === 'success' ? 'Verify & Pay' : action === 'fail' ? 'Fail payment' : 'Cancel'}</button>`,
    )
    .join('\n');
  return shell(
    'bKash checkout (simulator)',
    `<h1>bKash checkout (simulator)</h1>
<p>Merchant: <strong>${input.appName}</strong></p>
<p>Invoice: <code>${input.invoice}</code></p>
<p>Amount: <strong>${input.amount} ${input.currency}</strong></p>
<p>Payment ID: <code>${input.paymentId}</code></p>
<p>State: <code>${input.state}</code></p>
${input.notice ? `<p><em>${input.notice}</em></p>` : ''}
<form method="POST">
<input type="hidden" name="paymentId" value="${input.paymentId}">
${buttons}
</form>
<p><small>Wallet / OTP / PIN entry is theater in the simulator: pick an outcome above. The real page performs verification; the simulator jumps straight to the callback.</small></p>`,
  );
}

export interface RedirectPageInput {
  kind: 'success' | 'failure' | 'cancel';
  paymentId: string;
  targetUrl: string;
}

export function redirectPage(input: RedirectPageInput): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${input.targetUrl}"><title>Returning to merchant…</title></head>
<body style="font-family: sans-serif; max-width: 560px; margin: 2rem auto; padding: 0 1rem;">
<div style="background: #fbbf24; color: #000; padding: 0.5rem 1rem; font-weight: bold; text-align: center;">SIMULATOR</div>
<h1>Verification ${input.kind}</h1>
<p>Payment ID: <code>${input.paymentId}</code></p>
<p>Continuing to the merchant…</p>
<p><a id="continue" href="${input.targetUrl}">Continue to merchant</a></p>
</body>
</html>`;
}

export function errorPage(title: string, message: string, status: number): string {
  return shell(title, `<h1>${title}</h1><p>${message}</p><p>Status: ${status}</p>`);
}
