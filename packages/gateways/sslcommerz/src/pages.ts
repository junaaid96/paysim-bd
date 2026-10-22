// Simulator-owned HTML: the mock hosted payment page and the auto-POST
// return form. Content is ours (PaySim sandbox label everywhere); only the
// gw.php path + SESSIONKEY param mirror the real gateway.

import { createHash } from 'node:crypto';

import { SANDBOX_LABEL, cardCheckoutPage } from '@paysim/core';

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const BANNER = `<div class="sim">${SANDBOX_LABEL}</div>`;

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
    '<div class="foot">PaySim BD sandbox simulator · not affiliated with any payment provider</div>' +
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
  return cardCheckoutPage({
    sessionkey: input.sessionkey,
    merchant: input.storeName,
    amount: input.amount,
    currency: input.currency,
    tranId: input.tranId,
    state: input.state,
    ...(input.notice ? { notice: input.notice } : {}),
  });
}

/** Inline auto-submit script of the return page (hashed into its CSP). */
export const AUTO_SUBMIT_SCRIPT = 'document.getElementById("sim-return").submit();';

/**
 * CSP for the return page: the default helmet policy blocks both the inline
 * auto-submit script and a form POST to the merchant's (external) URL, which
 * left browsers stuck on "Returning to merchant…".
 */
export function autoPostCsp(): string {
  const hash = createHash('sha256').update(AUTO_SUBMIT_SCRIPT).digest('base64');
  return [
    "default-src 'self'",
    `script-src 'sha256-${hash}'`,
    "style-src 'self' 'unsafe-inline'",
    'form-action http: https:',
    "base-uri 'self'",
    "frame-ancestors 'self'",
    "object-src 'none'",
  ].join('; ');
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
      `<script>${AUTO_SUBMIT_SCRIPT}</script>`,
  );
}

export function errorPage(title: string, message: string, statusCode: number): string {
  return shell(
    title,
    `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p>HTTP ${statusCode} — simulator mock page.</p>`,
  );
}
