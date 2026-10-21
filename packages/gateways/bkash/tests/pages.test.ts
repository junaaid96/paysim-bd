import { describe, expect, it } from 'vitest';

import { checkoutPage, redirectPage } from '../src/pages.js';

describe('bkash pages', () => {
  it('escapes dashboard-supplied app names', () => {
    const html = checkoutPage({
      paymentId: 'P1',
      amount: '1.00',
      currency: 'BDT',
      invoice: 'INV-1',
      appName: '<img src=x onerror=alert(1)>',
      state: 'initiated',
    });
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('never renders non-http redirect targets', () => {
    const html = redirectPage({
      kind: 'success',
      paymentId: 'P1',
      targetUrl: 'javascript:alert(1)',
    });
    expect(html).not.toContain('javascript:');
    const ok = redirectPage({
      kind: 'success',
      paymentId: 'P1',
      targetUrl: 'https://m.test/cb?a=1&b=2',
    });
    expect(ok).toContain('https://m.test/cb?a=1&amp;b=2');
  });
});
