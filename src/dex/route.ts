import { useCallback, useEffect, useState } from 'react';

export type DexSection = 'swap' | 'trade' | 'pools' | 'perps';

const SECTIONS: readonly DexSection[] = ['swap', 'trade', 'pools', 'perps'];
/** Sub-paths of the previous DEX layout, so old links still land somewhere sensible. */
const LEGACY: Record<string, DexSection> = { orders: 'trade', limit: 'trade', liquidity: 'pools', create: 'pools' };
const NAVIGATE_EVENT = 'series9:dex-navigate';

function basePath(): string {
  return import.meta.env.BASE_URL.replace(/\/+$/, '');
}

export function readDexSection(pathname: string = window.location.pathname): DexSection {
  const base = basePath();
  const path = base && pathname.startsWith(base) ? pathname.slice(base.length) : pathname;
  const [, first, second] = path.replace(/\/+$/, '').split('/');
  if (first !== 'dex' || !second) return 'swap';
  if ((SECTIONS as readonly string[]).includes(second)) return second as DexSection;
  return LEGACY[second] ?? 'swap';
}

export function dexHref(section: DexSection): string {
  return `${basePath()}/dex/${section}`;
}

export function useDexSection(): [DexSection, (section: DexSection) => void] {
  const [section, setSection] = useState<DexSection>(readDexSection);
  useEffect(() => {
    const sync = () => setSection(readDexSection());
    window.addEventListener('popstate', sync);
    window.addEventListener(NAVIGATE_EVENT, sync);
    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener(NAVIGATE_EVENT, sync);
    };
  }, []);
  const navigate = useCallback((next: DexSection) => {
    const href = dexHref(next);
    if (window.location.pathname !== href) {
      window.history.pushState({}, '', href);
      window.dispatchEvent(new Event(NAVIGATE_EVENT));
    }
  }, []);
  return [section, navigate];
}
