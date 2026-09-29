import type { WalletState } from '../useWallet.ts';
import { asUint } from './abi.ts';
import { TOKENS } from '../chain.ts';
import { sameAddress, type TokenInfo } from './config.ts';
import { wrapMon } from './actions.ts';
import { batch, call, type PairInfo } from './reads.ts';
import { approveStep, type AnyStep, type LazyStep, type TxStep } from './useTxRunner.ts';

export type Notify = (message: string, kind?: 'success' | 'error') => void;

/** Everything a DEX view needs from the shell, passed down as one prop. */
export type DexCtx = {
  wallet: WalletState;
  account: string | null;
  tokens: TokenInfo[];
  withNative: TokenInfo[];
  importToken: (address: string) => Promise<TokenInfo | null>;
  pairs: PairInfo[];
  marketsLoading: boolean;
  paused: boolean;
  balances: Map<string, bigint>;
  nativeBalance: bigint | null;
  busy: string | null;
  run: (title: string, steps: AnyStep[]) => Promise<boolean>;
  refresh: () => void;
  refreshSignal: number;
  notify: Notify;
  tokenFor: (address: string | null | undefined) => TokenInfo | null;
  trackPair: (pair: string) => void;
};

export function balanceOf(ctx: DexCtx, token: TokenInfo | null | undefined): bigint | null {
  if (!token || !ctx.account) return null;
  return ctx.balances.get(token.address.toLowerCase()) ?? null;
}

export type Spend = { token: TokenInfo; spender: string; amount: bigint };

/**
 * Approval steps for every spend whose live allowance is short. Read at
 * submit time rather than from the poll, so a just-mined approval counts.
 */
export async function approvalsFor(owner: string, spends: Spend[]): Promise<TxStep[]> {
  const needed = spends.filter((spend) => spend.amount > 0n);
  if (needed.length === 0) return [];
  const results = await batch(needed.map((spend) => call(spend.token.address, 'allowance(address,address)', [owner, spend.spender])));
  return needed.flatMap((spend, index) => {
    const current = asUint(results[index]) ?? 0n;
    return current >= spend.amount ? [] : [approveStep(spend.token.address, spend.token.symbol, spend.spender, spend.amount)];
  });
}

/**
 * When a WMON spend exceeds the WMON balance, wrap the gap from native MON
 * first. Returns null when even wrapping cannot cover it.
 */
export function wrapFor(token: TokenInfo, amount: bigint, wmonBalance: bigint, native: bigint | null, gasReserve: bigint): TxStep[] | null {
  if (!sameAddress(token.address, TOKENS.wmon) || amount <= wmonBalance) return amount <= wmonBalance ? [] : null;
  const gap = amount - wmonBalance;
  if (native === null || native <= gasReserve || native - gasReserve < gap) return null;
  return [wrapMon(gap)];
}

/**
 * One lazy approval step per spend. Each re-reads allowances when it runs and
 * sends the first approval still missing, so already-sufficient allowances
 * cost nothing and a just-mined approval is never sent twice.
 */
export function approvalSteps(owner: string, spends: Spend[]): LazyStep[] {
  return spends.map(() => ({
    label: '토큰 승인',
    build: async () => (await approvalsFor(owner, spends))[0] ?? null,
  }));
}
