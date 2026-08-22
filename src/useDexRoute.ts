import { useCallback, useEffect, useState } from 'react';

export type DexTab = 'swap' | 'liquidity' | 'orders' | 'create';

const DEX_SECTIONS: readonly DexTab[] = ['swap', 'liquidity', 'orders', 'create'];
const DEX_NAVIGATE_EVENT = 'series9:dex-navigate';

function stripBasePath(pathname: string): string {
  const basePath = import.meta.env.BASE_URL.replace(/\/+$/, '');
  return basePath && (pathname === basePath || pathname.startsWith(`${basePath}/`))
    ? pathname.slice(basePath.length)
    : pathname;
}

export function readDexSection(pathname: string = window.location.pathname): DexTab {
  const [, first, second] = stripBasePath(pathname).replace(/\/+$/, '').split('/');
  if (first === 'dex' && second && (DEX_SECTIONS as readonly string[]).includes(second)) {
    return second as DexTab;
  }
  return 'swap';
}

export function dexHref(section: DexTab): string {
  return `${import.meta.env.BASE_URL.replace(/\/+$/, '')}/dex/${section}`;
}

/** Client-side jump between DEX sub-pages; popstate and the custom event re-sync listeners. */
export function navigateToDexSection(section: DexTab): void {
  const href = dexHref(section);
  if (window.location.pathname === href) return;
  window.history.pushState({}, '', href);
  window.dispatchEvent(new Event(DEX_NAVIGATE_EVENT));
}

export function useDexSection(): [DexTab, (section: DexTab) => void] {
  const [section, setSection] = useState<DexTab>(readDexSection);

  useEffect(() => {
    const sync = () => setSection(readDexSection());
    window.addEventListener('popstate', sync);
    window.addEventListener(DEX_NAVIGATE_EVENT, sync);
    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener(DEX_NAVIGATE_EVENT, sync);
    };
  }, []);

  const navigate = useCallback((next: DexTab) => navigateToDexSection(next), []);
  return [section, navigate];
}
