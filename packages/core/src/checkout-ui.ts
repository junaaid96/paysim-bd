// Simulator checkout pages (HTML strings) shared by the gateway plugins.
// They approximate each provider's hosted flow with our own styling and
// plain-text wordmarks (no provider logos or assets). Every page carries a
// persistent "PaySim sandbox — test only, no real money" label. No
// JavaScript: wallet steps advance with plain form posts, and OTP/PIN/card
// inputs have no `name`, so they are never submitted or stored.

export function esc(input: unknown): string {
  return String(input ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const SANDBOX_LABEL = 'PaySim sandbox — test only, no real money';

export type Brand = 'bkash' | 'nagad' | 'sslcommerz';

const BRANDS: Record<
  Brand,
  { name: string; primary: string; dark: string; soft: string; head: string }
> = {
  bkash: {
    name: 'bKash',
    primary: '#d12053',
    dark: '#a3164a',
    soft: '#fdeef3',
    head: 'linear-gradient(135deg,#e2136e,#b8125c)',
  },
  nagad: {
    name: 'Nagad',
    primary: '#e2531c',
    dark: '#b83e10',
    soft: '#fff1e8',
    head: 'linear-gradient(135deg,#f7931e,#ec3b23)',
  },
  sslcommerz: {
    name: 'SSLCommerz',
    primary: '#1b5fb4',
    dark: '#134a8f',
    soft: '#eaf2fc',
    head: 'linear-gradient(135deg,#1f6fd1,#123f7a)',
  },
};

function baseCss(brand: Brand): string {
  const b = BRANDS[brand];
  return [
    `:root{--p:${b.primary};--pd:${b.dark};--ps:${b.soft}}`,
    '*{box-sizing:border-box}',
    'body{margin:0;font-family:Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#eef0f3;color:#1f2329;line-height:1.45}',
    '.sbx{position:sticky;top:0;z-index:10;background:#111827;color:#fde68a;text-align:center;font-size:12.5px;font-weight:600;padding:.45rem .75rem;letter-spacing:.01em}',
    '.sbx b{color:#fff}',
    '.wrap{max-width:440px;margin:1.25rem auto 2rem;padding:0 .75rem}',
    '.card{background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 12px 32px rgba(17,24,39,.12)}',
    `.head{background:${b.head};color:#fff;padding:1rem 1.15rem 1.1rem}`,
    '.brandrow{display:flex;align-items:center;justify-content:space-between;gap:.5rem}',
    '.wordmark{font-weight:800;font-size:1.35rem;letter-spacing:-.02em}',
    '.tag{font-size:11px;font-weight:700;background:rgba(255,255,255,.2);border:1px solid rgba(255,255,255,.35);padding:.15rem .5rem;border-radius:999px;white-space:nowrap}',
    '.merchant{margin-top:.85rem;display:flex;align-items:center;justify-content:space-between;gap:.75rem;background:rgba(255,255,255,.14);border-radius:12px;padding:.65rem .8rem}',
    '.merchant small{display:block;opacity:.85;font-size:12px}',
    '.merchant strong{display:block;font-size:15px;overflow-wrap:anywhere}',
    '.amt{text-align:right;white-space:nowrap}',
    '.amt strong{font-size:1.25rem}',
    '.body{padding:1.15rem}',
    'h1{font-size:1.05rem;margin:0 0 .25rem}',
    '.muted{color:#5b6472;font-size:13px;margin:.15rem 0 .9rem}',
    'label{display:block;font-size:13px;font-weight:600;margin:.65rem 0 .3rem}',
    'input[type=text],input[type=tel],input[type=password]{width:100%;font:inherit;font-size:16px;padding:.7rem .8rem;border:1.5px solid #d3d8df;border-radius:10px;background:#fff;color:#1f2329}',
    'input:focus-visible,button:focus-visible,.tabs label:focus-within{outline:3px solid var(--p);outline-offset:2px}',
    '.hint{font-size:12px;color:#5b6472;background:#f6f7f9;border:1px dashed #cfd5dd;border-radius:8px;padding:.45rem .6rem;margin-top:.5rem}',
    '.hint code{font-size:12px;color:#1f2329}',
    '.err{color:#b42318;background:#fef3f2;border:1px solid #fecdca;border-radius:8px;padding:.5rem .65rem;font-size:13px;margin:.5rem 0}',
    '.note{color:#344054;background:var(--ps);border-radius:8px;padding:.5rem .65rem;font-size:13px;margin:.5rem 0}',
    '.actions{display:flex;gap:.5rem;margin-top:1rem;flex-wrap:wrap}',
    'button{font:inherit;font-weight:700;border-radius:10px;padding:.75rem 1rem;cursor:pointer;border:1.5px solid transparent;min-height:44px}',
    '.primary{background:var(--p);color:#fff;flex:1 1 auto}',
    '.primary:hover{background:var(--pd)}',
    '.ghost{background:#fff;color:#344054;border-color:#d0d5dd}',
    '.ghost:hover{background:#f2f4f7}',
    '.simrow{margin-top:1rem;padding-top:.85rem;border-top:1px solid #eaecf0;display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;font-size:12px;color:#5b6472}',
    '.simrow button{min-height:36px;padding:.45rem .75rem;font-size:12.5px}',
    '.steps{display:flex;gap:.35rem;margin:0 0 .9rem;padding:0;list-style:none}',
    '.steps li{flex:1;height:4px;border-radius:4px;background:#e4e7ec}',
    '.steps li.on{background:var(--p)}',
    '.meta{display:flex;justify-content:space-between;gap:.5rem;font-size:12px;color:#5b6472;margin-top:.9rem;flex-wrap:wrap}',
    '.meta code{color:#344054;overflow-wrap:anywhere}',
    '.foot{text-align:center;font-size:11.5px;color:#667085;margin-top:.9rem}',
    '.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}',
  ].join('');
}

function page(brand: Brand, title: string, inner: string, extraCss = ''): string {
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="robots" content="noindex">' +
    `<title>${esc(title)} · ${SANDBOX_LABEL}</title>` +
    `<style>${baseCss(brand)}${extraCss}</style></head><body>` +
    `<div class="sbx" role="note"><b>${SANDBOX_LABEL}</b> · any test values work · never enter a real PIN or card</div>` +
    `<main class="wrap">${inner}` +
    '<p class="foot">PaySim BD simulator · not affiliated with any payment provider</p>' +
    '</main></body></html>'
  );
}

function header(brand: Brand, merchant: string, amount: string, currency: string): string {
  return (
    `<div class="head"><div class="brandrow"><span class="wordmark">${esc(BRANDS[brand].name)}</span>` +
    '<span class="tag">TEST MODE</span></div>' +
    `<div class="merchant"><div><small>Pay to</small><strong>${esc(merchant)}</strong></div>` +
    `<div class="amt"><small>Amount</small><strong>৳${esc(amount)}</strong> <small>${esc(currency)}</small></div></div></div>`
  );
}

export interface WalletCheckoutInput {
  brand: 'bkash' | 'nagad';
  /** Hidden field name + value identifying the payment (paymentId / paymentRefId). */
  idField: string;
  idValue: string;
  merchant: string;
  amount: string;
  currency: string;
  reference: string;
  referenceLabel: string;
  state: string;
  /** True while the payment can still be completed on this page. */
  open: boolean;
  step: 'number' | 'otp' | 'pin';
  /** Test wallet number carried between steps (display only). */
  wallet?: string;
  error?: string;
  notice?: string;
}

const WALLET_HINTS = {
  bkash: { number: '01770618575', otp: '123456', pin: '12121' },
  nagad: { number: '01711000000', otp: '123456', pin: '1234' },
} as const;

/** Bangladeshi mobile number shape: 11 digits starting 01. */
export const WALLET_NUMBER = /^01[3-9]\d{8}$/;

function maskWallet(wallet: string): string {
  return wallet.length === 11 ? `${wallet.slice(0, 3)}****${wallet.slice(-4)}` : wallet;
}

function simControls(idField: string, idValue: string): string {
  return (
    '<form method="POST" class="simrow"><span>Simulator controls:</span>' +
    `<input type="hidden" name="${esc(idField)}" value="${esc(idValue)}">` +
    '<button class="ghost" type="submit" name="action" value="fail">Simulate failure</button>' +
    '<button class="ghost" type="submit" name="action" value="cancel">Cancel payment</button></form>'
  );
}

export function walletCheckoutPage(input: WalletCheckoutInput): string {
  const brand = BRANDS[input.brand];
  const hints = WALLET_HINTS[input.brand];
  const head = header(input.brand, input.merchant, input.amount, input.currency);
  const meta =
    `<div class="meta"><span>${esc(input.referenceLabel)}: <code>${esc(input.reference)}</code></span>` +
    `<span>ID: <code>${esc(input.idValue)}</code></span></div>`;
  if (!input.open) {
    return page(
      input.brand,
      `${brand.name} payment`,
      `<div class="card">${head}<div class="body"><h1>This payment is ${esc(input.state)}</h1>` +
        `<p class="muted">${esc(input.notice ?? 'The session is closed; the outcome cannot change.')}</p>${meta}</div></div>`,
    );
  }
  const stepIndex = input.step === 'number' ? 0 : input.step === 'otp' ? 1 : 2;
  const steps =
    '<ol class="steps" aria-label="Progress">' +
    [0, 1, 2]
      .map(
        (i) =>
          `<li class="${i <= stepIndex ? 'on' : ''}"><span class="sr">Step ${i + 1}</span></li>`,
      )
      .join('') +
    '</ol>';
  const hidden =
    `<input type="hidden" name="${esc(input.idField)}" value="${esc(input.idValue)}">` +
    (input.wallet ? `<input type="hidden" name="wallet" value="${esc(input.wallet)}">` : '');
  const error = input.error ? `<p class="err" role="alert">${esc(input.error)}</p>` : '';
  const notice = input.notice ? `<p class="note" role="status">${esc(input.notice)}</p>` : '';
  let body: string;
  if (input.step === 'number') {
    body =
      `<h1>Your ${esc(brand.name)} account number</h1><p class="muted">Enter the test wallet number to continue.</p>${error}${notice}` +
      `<form method="POST">${hidden}<input type="hidden" name="step" value="otp">` +
      '<label for="wallet">Account number</label>' +
      `<input id="wallet" name="wallet" type="tel" inputmode="numeric" autocomplete="off" required pattern="01[3-9][0-9]{8}" maxlength="11" placeholder="e.g ${hints.number}" aria-describedby="h1">` +
      `<p class="hint" id="h1">Test number: <code>${hints.number}</code> (any 11-digit 01… number works)</p>` +
      '<p class="muted" style="margin-top:.6rem;font-size:12px">By continuing you accept the simulator terms: no real wallet is touched.</p>' +
      '<div class="actions"><button class="primary" type="submit">Proceed</button></div></form>';
  } else if (input.step === 'otp') {
    body =
      `<h1>Verification code</h1><p class="muted">A test code was "sent" to ${esc(maskWallet(input.wallet ?? ''))}.</p>${error}` +
      `<form method="POST">${hidden}<input type="hidden" name="step" value="pin">` +
      '<label for="otp">Verification code (OTP)</label>' +
      `<input id="otp" type="text" inputmode="numeric" autocomplete="one-time-code" required pattern="[0-9]{4,6}" maxlength="6" placeholder="${hints.otp}" aria-describedby="h2">` +
      `<p class="hint" id="h2">Test OTP: <code>${hints.otp}</code> (any 4–6 digits; not sent or stored)</p>` +
      '<div class="actions"><button class="primary" type="submit">Verify</button></div></form>';
  } else {
    body =
      `<h1>Enter PIN</h1><p class="muted">Confirm ৳${esc(input.amount)} from ${esc(maskWallet(input.wallet ?? ''))}.</p>${error}` +
      `<form method="POST">${hidden}` +
      '<label for="pin">Test PIN</label>' +
      `<input id="pin" type="password" inputmode="numeric" autocomplete="off" required pattern="[0-9]{4,5}" maxlength="5" placeholder="•••••" aria-describedby="h3">` +
      `<p class="hint" id="h3">Test PIN: <code>${hints.pin}</code>. Never use a real PIN — this field is not sent anywhere.</p>` +
      '<div class="actions"><button class="primary" type="submit" name="action" value="success">Confirm payment</button></div></form>';
  }
  return page(
    input.brand,
    `${brand.name} checkout`,
    `<div class="card">${head}<div class="body">${steps}${body}${meta}${simControls(input.idField, input.idValue)}</div></div>`,
  );
}

export interface CardCheckoutInput {
  sessionkey: string;
  merchant: string;
  amount: string;
  currency: string;
  tranId: string;
  state: string;
  notice?: string;
}

const TABS_CSS = [
  '.tabs{display:flex;gap:.35rem;background:#f2f4f7;border-radius:12px;padding:.3rem;margin-bottom:.9rem}',
  '.tabs label{flex:1;text-align:center;margin:0;padding:.55rem .4rem;border-radius:9px;font-size:13px;cursor:pointer;color:#475467}',
  'input[name=tab]{position:absolute;opacity:0;pointer-events:none}',
  '#t-card:focus-visible~.tabs label[for=t-card],#t-mob:focus-visible~.tabs label[for=t-mob],#t-net:focus-visible~.tabs label[for=t-net]{outline:3px solid var(--p);outline-offset:2px}',
  '.pane{display:none}',
  '#t-card:checked~.tabs label[for=t-card],#t-mob:checked~.tabs label[for=t-mob],#t-net:checked~.tabs label[for=t-net]{background:#fff;color:var(--p);box-shadow:0 1px 3px rgba(16,24,40,.12);font-weight:700}',
  '#t-card:checked~.p-card,#t-mob:checked~.p-mob,#t-net:checked~.p-net{display:block}',
  '.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:.5rem}',
  '.tile{background:#fff;border:1.5px solid #d0d5dd;color:#1f2329;font-weight:700;padding:.85rem .5rem;border-radius:12px;width:100%}',
  '.tile:hover{border-color:var(--p);background:var(--ps)}',
  '.tile small{display:block;font-weight:500;color:#667085;font-size:11px}',
  '.row2{display:grid;grid-template-columns:1fr 1fr;gap:.6rem}',
].join('');

export function cardCheckoutPage(input: CardCheckoutInput): string {
  const head = header('sslcommerz', input.merchant, input.amount, input.currency);
  const meta = `<div class="meta"><span>Order: <code>${esc(input.tranId)}</code></span></div>`;
  if (input.state !== 'initiated') {
    return page(
      'sslcommerz',
      'SSLCommerz payment',
      `<div class="card">${head}<div class="body"><h1>This payment is ${esc(input.state)}</h1>` +
        `<p class="muted">${esc(input.notice ?? 'The session is closed; the outcome cannot change.')}</p>${meta}</div></div>`,
      TABS_CSS,
    );
  }
  const sk = `<input type="hidden" name="SESSIONKEY" value="${esc(input.sessionkey)}">`;
  const tile = (name: string, sub: string): string =>
    `<button class="tile" type="submit" name="action" value="success" aria-label="Pay with ${esc(name)} (test)">${esc(name)}<small>${esc(sub)}</small></button>`;
  const body =
    '<h1>Choose a payment method</h1><p class="muted">Pick any method; every option completes with test values.</p>' +
    (input.notice ? `<p class="note" role="status">${esc(input.notice)}</p>` : '') +
    '<input type="radio" name="tab" id="t-card" checked><input type="radio" name="tab" id="t-mob"><input type="radio" name="tab" id="t-net">' +
    '<div class="tabs">' +
    '<label for="t-card">Cards</label><label for="t-mob">Mobile banking</label><label for="t-net">Net banking</label></div>' +
    `<form method="POST" class="pane p-card" aria-label="Card payment">${sk}` +
    '<label for="cn">Card number</label>' +
    '<input id="cn" type="text" inputmode="numeric" autocomplete="off" required pattern="[0-9 ]{12,23}" maxlength="23" placeholder="4111 1111 1111 1111" aria-describedby="ch">' +
    '<div class="row2"><div><label for="ce">Expiry (MM/YY)</label><input id="ce" type="text" autocomplete="off" required pattern="(0[1-9]|1[0-2])/[0-9]{2}" maxlength="5" placeholder="12/30"></div>' +
    '<div><label for="cv">CVC</label><input id="cv" type="password" inputmode="numeric" autocomplete="off" required pattern="[0-9]{3,4}" maxlength="4" placeholder="123"></div></div>' +
    '<label for="cnm">Name on card</label><input id="cnm" type="text" autocomplete="off" placeholder="Test Customer">' +
    '<p class="hint" id="ch">Test card: <code>4111 1111 1111 1111</code>, any future expiry, CVC <code>123</code>. Card fields are not sent or stored.</p>' +
    `<div class="actions"><button class="primary" type="submit" name="action" value="success">Pay ৳${esc(input.amount)}</button></div></form>` +
    `<form method="POST" class="pane p-mob" aria-label="Mobile banking">${sk}<div class="grid">` +
    tile('bKash', 'mobile wallet') +
    tile('Nagad', 'mobile wallet') +
    tile('Rocket', 'mobile wallet') +
    tile('Upay', 'mobile wallet') +
    '</div><p class="hint">Wallets complete instantly here with test values.</p></form>' +
    `<form method="POST" class="pane p-net" aria-label="Net banking">${sk}<div class="grid">` +
    tile('City Bank', 'internet banking') +
    tile('BRAC Bank', 'internet banking') +
    tile('Dutch-Bangla', 'internet banking') +
    tile('Islami Bank', 'internet banking') +
    '</div><p class="hint">Bank logins are simulated; no credentials are asked for.</p></form>';
  const sim =
    `<form method="POST" class="simrow"><span>Simulator controls:</span>${sk}` +
    '<button class="ghost" type="submit" name="action" value="fail">Simulate failure</button>' +
    '<button class="ghost" type="submit" name="action" value="cancel">Cancel payment</button></form>';
  return page(
    'sslcommerz',
    'SSLCommerz checkout',
    `<div class="card">${head}<div class="body">${body}${meta}${sim}</div></div>`,
    TABS_CSS,
  );
}

/**
 * Resolve the next wallet step from a step-advance POST. Values are test
 * inputs only; the OTP/PIN never reach the server (their inputs have no name).
 */
export function nextWalletStep(body: Record<string, unknown>): {
  step: 'number' | 'otp' | 'pin';
  wallet: string;
  error?: string;
} {
  const requested = typeof body['step'] === 'string' ? body['step'] : '';
  const wallet = typeof body['wallet'] === 'string' ? body['wallet'].replace(/\s+/g, '') : '';
  if (!WALLET_NUMBER.test(wallet)) {
    return {
      step: 'number',
      wallet: '',
      error: 'Enter an 11-digit test number that starts with 01 (e.g. 01770618575).',
    };
  }
  return { step: requested === 'pin' ? 'pin' : 'otp', wallet };
}
