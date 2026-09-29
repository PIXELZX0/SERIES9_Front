import { useCallback, useEffect, useRef, useState } from 'react';
import { MONAD } from '../chain.ts';
import type { WalletState } from '../useWallet.ts';
import { describeRevert, encodeFunction } from './abi.ts';
import { allowanceKey, simulate } from './reads.ts';

export type TxStep = {
  /** Shown in the wallet-status line and in notifications. */
  label: string;
  to: string;
  data: string;
  value?: bigint;
  /** Skip the pre-sign `eth_call` (e.g. WMON deposit, which cannot revert usefully). */
  skipSimulation?: boolean;
};

/** A step whose calldata depends on what earlier steps did (e.g. unwrap exactly what a swap paid out). */
export type LazyStep = {
  label: string;
  build: () => Promise<TxStep | null>;
};

export type AnyStep = TxStep | LazyStep;

export type TxRunState = {
  busy: string | null;
  /** A submitted hash whose receipt never came back; writes stay blocked until it is resolved. */
  unresolved: { hash: string; label: string } | null;
};

type Notify = (message: string, kind?: 'success' | 'error') => void;

const UNRESOLVED_KEY = 'series9:dex-unresolved-tx';

function readUnresolved(): TxRunState['unresolved'] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(UNRESOLVED_KEY) ?? 'null') as TxRunState['unresolved'];
    return parsed && /^0x[0-9a-fA-F]{64}$/.test(parsed.hash) && typeof parsed.label === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

function writeUnresolved(value: TxRunState['unresolved']): void {
  try {
    if (value) window.localStorage.setItem(UNRESOLVED_KEY, JSON.stringify(value));
    else window.localStorage.removeItem(UNRESOLVED_KEY);
  } catch {
    // Storage off: the block lasts for this visit only.
  }
}

function short(hash: string): string {
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}

export function approveStep(token: string, symbol: string, spender: string, amount: bigint): TxStep {
  return {
    label: `${symbol} 승인`,
    to: token,
    data: encodeFunction('approve(address,uint256)', [spender, amount]),
  };
}

/** An approval step when the current allowance is below `amount`, otherwise nothing. */
export function approvalIfNeeded(
  allowances: Map<string, bigint> | undefined,
  token: string,
  symbol: string,
  spender: string,
  amount: bigint,
): TxStep[] {
  const current = allowances?.get(allowanceKey(token, spender)) ?? 0n;
  return current >= amount ? [] : [approveStep(token, symbol, spender, amount)];
}

/**
 * Runs a list of wallet transactions in order: simulate → sign → wait, one at
 * a time, so an approval is mined before the call that spends it is simulated.
 */
export function useTxRunner(wallet: WalletState, notify: Notify, onActionState: (label: string | null) => void, onConfirmed: () => void) {
  const [state, setState] = useState<TxRunState>({ busy: null, unresolved: readUnresolved() });
  const running = useRef(false);
  const mounted = useRef(true);
  // The shell's callbacks are not guaranteed stable; hold the latest in refs so
  // they never re-run effects (a cleanup that reports "idle" would loop).
  const actionStateRef = useRef(onActionState);
  const confirmedRef = useRef(onConfirmed);
  useEffect(() => {
    actionStateRef.current = onActionState;
    confirmedRef.current = onConfirmed;
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      actionStateRef.current(null);
    };
  }, []);

  const setBusy = useCallback((busy: string | null) => {
    if (mounted.current) setState((previous) => ({ ...previous, busy }));
    actionStateRef.current(busy);
  }, []);

  const ensureWallet = useCallback(async (): Promise<string | null> => {
    if (!wallet.address) {
      const result = await wallet.connect();
      if (result.error) notify(result.error, 'error');
      return null;
    }
    if (!wallet.onMonad) {
      try {
        await wallet.switchToMonad();
        notify(`${MONAD.name}로 전환했습니다. 다시 실행해 주세요.`);
      } catch (error) {
        notify(error instanceof Error ? error.message : '지갑을 Monad로 전환해 주세요.', 'error');
      }
      return null;
    }
    return wallet.address;
  }, [notify, wallet]);

  const run = useCallback(async (title: string, steps: AnyStep[]): Promise<boolean> => {
    if (steps.length === 0) return false;
    if (state.unresolved) {
      notify(`${short(state.unresolved.hash)} 트랜잭션 결과를 먼저 확인해 주세요.`, 'error');
      return false;
    }
    if (running.current) {
      notify('다른 DEX 트랜잭션이 진행 중입니다.', 'error');
      return false;
    }
    const from = await ensureWallet();
    if (!from) return false;
    running.current = true;
    let anyConfirmed = false;
    try {
      for (const [index, entry] of steps.entries()) {
        const step = 'build' in entry ? await entry.build() : entry;
        if (step === null) continue;
        const prefix = steps.length > 1 ? `${title} (${index + 1}/${steps.length}) ${step.label}` : step.label;
        if (!step.skipSimulation) {
          setBusy(`${prefix} · 시뮬레이션`);
          const result = await simulate(from, step.to, step.data, step.value);
          if (!result.ok) {
            notify(`${step.label} 실패 예상: ${describeRevert(result.data) ?? result.error}`, 'error');
            return false;
          }
        }
        setBusy(`${prefix} · 지갑 서명 대기`);
        let hash: string;
        try {
          hash = await wallet.sendTransaction({ to: step.to, data: step.data, value: step.value });
        } catch (error) {
          notify(error instanceof Error ? error.message : `${step.label} 전송 실패`, 'error');
          return false;
        }
        setBusy(`${prefix} · 컨펌 대기`);
        try {
          await wallet.waitForTransaction(hash);
        } catch (error) {
          const message = error instanceof Error ? error.message : '';
          if (/revert/i.test(message)) {
            notify(`${step.label} 트랜잭션이 revert 되었습니다 (${short(hash)}).`, 'error');
          } else {
            const unresolved = { hash, label: step.label };
            writeUnresolved(unresolved);
            if (mounted.current) setState((previous) => ({ ...previous, unresolved }));
            notify(`${step.label} ${short(hash)} 영수증을 확인하지 못했습니다. 탐색기에서 확인 후 해제해 주세요.`, 'error');
          }
          return false;
        }
        anyConfirmed = true;
      }
      notify(`${title} 완료`, 'success');
      return true;
    } finally {
      running.current = false;
      setBusy(null);
      if (anyConfirmed) confirmedRef.current();
    }
  }, [ensureWallet, notify, setBusy, state.unresolved, wallet]);

  const clearUnresolved = useCallback(async () => {
    const pending = state.unresolved;
    if (!pending) return;
    try {
      await wallet.waitForTransaction(pending.hash, { timeoutMs: 8000 });
      notify(`${pending.label} 트랜잭션이 확인되었습니다.`, 'success');
      confirmedRef.current();
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (!/revert/i.test(message)) {
        notify('아직 영수증이 없습니다. 탐색기에서 상태를 확인한 뒤 "무시"를 눌러 주세요.', 'error');
        return;
      }
      notify(`${pending.label} 트랜잭션은 revert 되었습니다.`, 'error');
    }
    writeUnresolved(null);
    setState((previous) => ({ ...previous, unresolved: null }));
  }, [notify, state.unresolved, wallet]);

  const dismissUnresolved = useCallback(() => {
    writeUnresolved(null);
    setState((previous) => ({ ...previous, unresolved: null }));
  }, []);

  return { ...state, run, clearUnresolved, dismissUnresolved };
}
