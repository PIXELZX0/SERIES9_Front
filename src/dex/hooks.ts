import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_TOKENS, MON, POLL_MS, normalizeAddress, type TokenInfo } from './config.ts';
import {
  cacheToken,
  readRegistry,
  readTokens,
  readUniverse,
  type RegistryStatus,
  type Universe,
} from './reads.ts';

DEFAULT_TOKENS.forEach(cacheToken);

export type Loaded<T> = {
  data: T | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
};

/**
 * Poll `load` every `POLL_MS` while `key` is stable. A new key aborts the
 * in-flight read and drops the stale data so one market never renders another
 * market's numbers.
 */
export function usePolled<T>(key: string | null, load: (signal: AbortSignal) => Promise<T>, refreshSignal = 0): Loaded<T> {
  const [state, setState] = useState<{ key: string | null; data: T | null; error: string | null; loading: boolean }>({
    key: null, data: null, error: null, loading: false,
  });
  const [version, setVersion] = useState(0);
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });

  useEffect(() => {
    if (key === null) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    setState((previous) => (previous.key === key ? { ...previous, loading: true } : { key, data: null, error: null, loading: true }));
    const tick = async () => {
      try {
        const data = await loadRef.current(controller.signal);
        if (active) setState({ key, data, error: null, loading: false });
      } catch (error) {
        if (!active || controller.signal.aborted) return;
        setState((previous) => ({ ...previous, loading: false, error: error instanceof Error ? error.message : 'Could not read Monad.' }));
      } finally {
        if (active) timer = setTimeout(() => void tick(), POLL_MS);
      }
    };
    void tick();
    return () => {
      active = false;
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [key, version, refreshSignal]);

  const refresh = useCallback(() => setVersion((value) => value + 1), []);
  const current = key !== null && state.key === key;
  return {
    data: current ? state.data : null,
    loading: key !== null && (!current || state.loading),
    error: current ? state.error : null,
    refresh,
  };
}

// ─────────────────── custom tokens ───────────────────

const CUSTOM_TOKENS_KEY = 'series9:dex-custom-tokens';

function readCustomTokenAddresses(): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(CUSTOM_TOKENS_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.map((entry) => normalizeAddress(String(entry))).filter((entry): entry is string => !!entry).slice(0, 20) : [];
  } catch {
    return [];
  }
}

function writeCustomTokenAddresses(addresses: string[]): void {
  try {
    window.localStorage.setItem(CUSTOM_TOKENS_KEY, JSON.stringify(addresses));
  } catch {
    // Storage off: custom tokens simply last for this visit.
  }
}

/** Default tokens plus any the user imported by address, resolved on-chain. */
export function useTokenList(): {
  tokens: TokenInfo[];
  withNative: TokenInfo[];
  importToken: (address: string) => Promise<TokenInfo | null>;
  removeToken: (address: string) => void;
} {
  const [customAddresses, setCustomAddresses] = useState<string[]>(readCustomTokenAddresses);
  const [customTokens, setCustomTokens] = useState<TokenInfo[]>([]);

  useEffect(() => {
    let active = true;
    if (customAddresses.length === 0) {
      queueMicrotask(() => {
        if (active) setCustomTokens([]);
      });
      return () => {
        active = false;
      };
    }
    readTokens(customAddresses).then((resolved) => {
      if (active) setCustomTokens(resolved);
    }).catch(() => undefined);
    return () => {
      active = false;
    };
  }, [customAddresses]);

  const importToken = useCallback(async (address: string) => {
    const normalized = normalizeAddress(address);
    if (!normalized) return null;
    const [token] = await readTokens([normalized]);
    if (!token) return null;
    setCustomAddresses((previous) => {
      if (previous.some((entry) => entry.toLowerCase() === normalized.toLowerCase()) ||
        DEFAULT_TOKENS.some((entry) => entry.address.toLowerCase() === normalized.toLowerCase())) return previous;
      const next = [...previous, normalized];
      writeCustomTokenAddresses(next);
      return next;
    });
    return token;
  }, []);

  const removeToken = useCallback((address: string) => {
    setCustomAddresses((previous) => {
      const next = previous.filter((entry) => entry.toLowerCase() !== address.toLowerCase());
      writeCustomTokenAddresses(next);
      return next;
    });
  }, []);

  const tokens = useMemo(() => {
    const seen = new Set<string>();
    return [...DEFAULT_TOKENS, ...customTokens].filter((token) => {
      const key = token.address.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [customTokens]);
  const withNative = useMemo(() => [MON, ...tokens], [tokens]);
  return { tokens, withNative, importToken, removeToken };
}

// ─────────────────── registry & universe ───────────────────

export function useRegistry(refreshSignal: number): Loaded<RegistryStatus> {
  return usePolled('registry', (signal) => readRegistry(signal), refreshSignal);
}

export function useUniverse(tokens: TokenInfo[], extraPairs: string[], refreshSignal: number): Loaded<Universe> {
  const key = [...tokens.map((token) => token.address.toLowerCase()), '|', ...extraPairs.map((pair) => pair.toLowerCase())].join(',');
  const tokensRef = useRef(tokens);
  const pairsRef = useRef(extraPairs);
  useEffect(() => {
    tokensRef.current = tokens;
    pairsRef.current = extraPairs;
  });
  return usePolled(`universe:${key}`, (signal) => readUniverse(tokensRef.current, pairsRef.current, signal), refreshSignal);
}

/** A 1 Hz clock in seconds, for expiry countdowns and TWAP readiness. */
export function useNow(): bigint {
  const [now, setNow] = useState(() => BigInt(Math.floor(Date.now() / 1000)));
  useEffect(() => {
    const id = setInterval(() => setNow(BigInt(Math.floor(Date.now() / 1000))), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}
