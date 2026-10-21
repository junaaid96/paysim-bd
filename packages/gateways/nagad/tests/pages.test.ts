import { describe, expect, it } from 'vitest';

import { checkoutPage, redirectPage } from '../src/pages.js';

describe('nagad pages', () => {
  it('escapes dashboard-supplied app names', () => {
    const html = checkoutPage({
      paymentRefId: 'R1',
      amount: '1.00',
      orderId: 'O1',
      appName: '"><script>alert(1)</script>',
      state: 'initiated',
    });
    expect(html).not.toContain('<script>alert(1)');
  });

  it('never renders non-http redirect targets', () => {
    const html = redirectPage({
      status: 'Success',
      paymentRefId: 'R1',
      targetUrl: 'javascript:alert(1)',
    });
    expect(html).not.toContain('javascript:');
  });
});
