import { useEffect, useState, type JSX, type ReactNode } from 'react';

export type Theme = 'dark' | 'light';

const THEME_KEY = 'paysim-theme';

function initialTheme(): Theme {
  try {
    const saved = window.localStorage.getItem(THEME_KEY);
    if (saved === 'dark' || saved === 'light') return saved;
  } catch {
    // storage unavailable (private mode): fall through to the OS preference
  }
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/** Dark/light theme persisted in localStorage, applied as a class on <html>. */
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  useEffect(() => {
    document.documentElement.classList.toggle('light', theme === 'light');
    try {
      window.localStorage.setItem(THEME_KEY, theme);
    } catch {
      // ignore
    }
  }, [theme]);
  return [theme, () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))];
}

export const GATEWAYS: Record<string, { name: string; mark: string; tone: string }> = {
  sslcommerz: { name: 'SSLCommerz', mark: 'SC', tone: 'bg-sky-900 text-sky-300' },
  bkash: { name: 'bKash', mark: 'bK', tone: 'bg-pink-950 text-pink-300' },
  nagad: { name: 'Nagad', mark: 'Ng', tone: 'bg-orange-950 text-orange-300' },
};

export function gatewayName(gateway: string): string {
  return GATEWAYS[gateway]?.name ?? gateway;
}

export function GatewayMark({
  gateway,
  size = 'md',
}: {
  gateway: string;
  size?: 'sm' | 'md';
}): JSX.Element {
  const meta = GATEWAYS[gateway];
  const dims = size === 'sm' ? 'h-6 w-6 text-[10px]' : 'h-9 w-9 text-xs';
  return (
    <span
      aria-hidden
      className={`inline-flex shrink-0 items-center justify-center rounded-lg font-bold ${dims} ${
        meta?.tone ?? 'bg-zinc-800 text-zinc-300'
      }`}
    >
      {meta?.mark ?? gateway.slice(0, 2)}
    </span>
  );
}

export function formatAmount(minor: number, currency: string): string {
  return `${(minor / 100).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ${currency}`;
}

export function stateTone(state: string): string {
  if (state === 'valid' || state === 'completed' || state === 'success')
    return 'bg-emerald-900 text-emerald-300';
  if (state === 'verified' || state === 'checkout') return 'bg-sky-900 text-sky-300';
  if (state === 'failed' || state === 'cancelled' || state === 'expired')
    return 'bg-red-900 text-red-300';
  if (state === 'refunded') return 'bg-violet-900 text-violet-300';
  if (state === 'refund declined') return 'bg-red-900 text-red-300';
  if (state === 'pending' || state === 'unattempted') return 'bg-amber-950 text-amber-300';
  return 'bg-zinc-800 text-zinc-300';
}

export function StateChip({ state }: { state: string }): JSX.Element {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${stateTone(state)}`}
    >
      {state}
    </span>
  );
}

export function LiveBadge({ status, label }: { status: string; label?: string }): JSX.Element {
  const live = status === 'live';
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-xs font-semibold ${
        live ? 'bg-emerald-900 text-emerald-300' : 'bg-amber-950 text-amber-300'
      }`}
    >
      {live ? (
        <span className="live-dot" />
      ) : (
        <span className="inline-flex h-2 w-2 rounded-full bg-amber-400" />
      )}
      {label ?? (live ? 'Live' : status)}
    </span>
  );
}

export function EmptyState({
  title,
  children,
  icon = '◎',
}: {
  title: string;
  children?: ReactNode;
  icon?: string;
}): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-zinc-800 px-6 py-10 text-center">
      <div className="mb-2 text-2xl text-zinc-600">{icon}</div>
      <p className="text-sm font-medium text-zinc-300">{title}</p>
      {children && <div className="mt-1 max-w-md text-xs text-zinc-500">{children}</div>}
    </div>
  );
}

export function SectionHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}): JSX.Element {
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
      <div>
        <h2 className="text-base font-semibold text-zinc-100">{title}</h2>
        {description && <p className="mt-0.5 text-sm text-zinc-500">{description}</p>}
      </div>
      {action}
    </div>
  );
}
