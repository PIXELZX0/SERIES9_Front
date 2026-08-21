import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  DEX_CONFIG,
  DEX_CONTRACTS,
  encodeErc20Approve,
  encodeSwapExactIn,
  normalizeDexAddress,
} from './dex.ts';
import { explorerAddressUrl, formatUnits, shortenAddress } from './chain.ts';
import { useDex, type DexPoolSnapshot, type DexToken } from './useDex.ts';
import type { WalletState } from './useWallet.ts';

type NotificationKind = 'success' | 'error';

type DexPageProps = {
  wallet: WalletState;
  onNotify: (message: string, kind?: NotificationKind) => void;
  onActionState: (label: string | null) => void;
};

type DexUnresolvedTransaction = {
  hash: string;
  label: string;
  walletAddress: string;
};

type DexUnresolvedTransactions = Record<string, DexUnresolvedTransaction>;

type DexOperation = {
  token: number;
  label: string;
  walletAddress: string | null;
  walletKey: string | null;
  hash: string | null;
  unresolved: boolean;
};

const EMPTY = '--';
const UINT256_LIMIT = 2n ** 256n;
const UNRESOLVED_TRANSACTION_STORAGE_KEY = 'series9:unresolved-submitted-transactions';
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const TRANSACTION_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

function walletAddressKey(address: string): string {
  return address.toLowerCase();
}

function sameTransactionHash(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getDexUnresolvedStorage(): Storage | null {
  if (typeof window === 'undefined') return null;

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isStoredDexUnresolvedTransaction(value: unknown, key: string): value is DexUnresolvedTransaction {
  if (!isRecord(value)) return false;

  const { hash, label, walletAddress } = value;
  return typeof hash === 'string' &&
    TRANSACTION_HASH_PATTERN.test(hash) &&
    !/^0+$/.test(hash.slice(2)) &&
    typeof label === 'string' &&
    label.trim().length > 0 &&
    typeof walletAddress === 'string' &&
    ADDRESS_PATTERN.test(walletAddress) &&
    walletAddressKey(walletAddress) === key;
}

function readStoredDexUnresolvedTransactions(storage: Storage): DexUnresolvedTransactions | null {
  let serialized: string | null;
  try {
    serialized = storage.getItem(UNRESOLVED_TRANSACTION_STORAGE_KEY);
  } catch {
    return null;
  }
  if (serialized === null) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const transactions: DexUnresolvedTransactions = {};
  for (const [storedKey, value] of Object.entries(parsed)) {
    const key = walletAddressKey(storedKey);
    if (!ADDRESS_PATTERN.test(storedKey) || !isStoredDexUnresolvedTransaction(value, key)) continue;
    transactions[key] = {
      hash: value.hash,
      label: value.label,
      walletAddress: value.walletAddress,
    };
  }
  return transactions;
}

function readDexUnresolvedTransactions(): DexUnresolvedTransactions {
  const storage = getDexUnresolvedStorage();
  if (!storage) return {};
  return readStoredDexUnresolvedTransactions(storage) ?? {};
}

function reloadDexUnresolvedTransactions(): DexUnresolvedTransactions | null {
  const storage = getDexUnresolvedStorage();
  if (!storage) return null;
  return readStoredDexUnresolvedTransactions(storage);
}

function persistDexUnresolvedTransaction(transaction: DexUnresolvedTransaction): void {
  const storage = getDexUnresolvedStorage();
  if (!storage) return;

  const transactions = readDexUnresolvedTransactions();
  transactions[walletAddressKey(transaction.walletAddress)] = transaction;
  try {
    storage.setItem(UNRESOLVED_TRANSACTION_STORAGE_KEY, JSON.stringify(transactions));
  } catch {
    // Storage can be disabled or unavailable in a private browsing context.
  }
}

function clearDexUnresolvedTransaction(walletAddress: string, expectedHash: string): boolean {
  const storage = getDexUnresolvedStorage();
  if (!storage) return true;

  const transactions = readStoredDexUnresolvedTransactions(storage);
  if (transactions === null) return false;

  const key = walletAddressKey(walletAddress);
  const transaction = transactions[key];
  if (!transaction) return true;
  if (!sameTransactionHash(transaction.hash, expectedHash)) return false;

  delete transactions[key];
  try {
    if (Object.keys(transactions).length === 0) {
      storage.removeItem(UNRESOLVED_TRANSACTION_STORAGE_KEY);
    } else {
      storage.setItem(UNRESOLVED_TRANSACTION_STORAGE_KEY, JSON.stringify(transactions));
    }
  } catch {
    return false;
  }

  const remainingTransactions = readStoredDexUnresolvedTransactions(storage);
  return remainingTransactions !== null && remainingTransactions[key] === undefined;
}

function tokenSymbol(token: DexToken | null): string {
  return token?.symbol?.trim() || (token ? shortenAddress(token.address) : 'Token');
}

function formatTokenValue(value: bigint | null, token: DexToken | null, precision = 5): string {
  if (value === null || token?.decimals === null || token === null) return EMPTY;
  return formatUnits(value, token.decimals, precision);
}

function formatPriceX18(
  priceX18: bigint | null,
  token0: DexToken | null,
  token1: DexToken | null,
): string {
  if (priceX18 === null || token0?.decimals === null || token1?.decimals === null || token0 === null || token1 === null) {
    return EMPTY;
  }

  const normalizedPrice = priceX18 * 10n ** BigInt(token0.decimals) / 10n ** BigInt(token1.decimals);
  return `${formatUnits(normalizedPrice, 18, 6)} ${tokenSymbol(token1)}`;
}

function formatFeePpm(value: bigint | null): string {
  return value === null ? EMPTY : `${formatUnits(value, 4, 4)}%`;
}

function formatPpmLimit(value: bigint | null): string {
  return value === null ? EMPTY : `${formatUnits(value, 4, 3)}% max`;
}

function parseTokenAmount(value: string, decimals: number | null): bigint | null {
  if (decimals === null) return null;
  const trimmed = value.trim();
  const normalized = trimmed.includes(',')
    ? /^\d{1,3}(?:,\d{3})*(?:\.\d*)?$/.test(trimmed) ? trimmed.replace(/,/g, '') : ''
    : trimmed;
  if (!/^\d*(?:\.\d*)?$/.test(normalized) || normalized === '' || normalized === '.') return null;

  const [whole = '0', fraction = ''] = normalized.split('.');
  if (fraction.length > decimals) return null;

  try {
    const amount = BigInt(whole || '0') * 10n ** BigInt(decimals) +
      BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals) || '0');
    return amount > 0n && amount < UINT256_LIMIT ? amount : null;
  } catch {
    return null;
  }
}

function parseSlippageBps(value: string): number | null {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d{0,2})?$/.test(normalized)) return null;
  const [whole = '0', fraction = ''] = normalized.split('.');
  const basisPoints = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(basisPoints) && basisPoints >= 0 && basisPoints <= 5_000 ? basisPoints : null;
}

function formatHash(hash: string): string {
  return `${hash.slice(0, 10)}...${hash.slice(-6)}`;
}

function firstDexUnresolvedTransaction(transactions: DexUnresolvedTransactions): DexUnresolvedTransaction | null {
  for (const key of Object.keys(transactions).sort()) {
    const transaction = transactions[key];
    if (transaction) return transaction;
  }
  return null;
}

function formatLevelPrice(
  priceX18: bigint | null,
  pool: DexPoolSnapshot,
): string {
  if (priceX18 === 0n) return 'Empty';
  return formatPriceX18(priceX18, pool.token0, pool.token1);
}

function InfrastructureCard({
  label,
  address,
  note,
  detail,
}: {
  label: string;
  address: string;
  note: string;
  detail?: string;
}) {
  return (
    <article className="dex-infra-card">
      <div className="dex-infra-card__topline">
        <span className="dex-infra-card__index" aria-hidden="true">/</span>
        <span>{note}</span>
      </div>
      <strong>{label}</strong>
      <code>{shortenAddress(address)}</code>
      {detail && <small>{detail}</small>}
      <a href={explorerAddressUrl(address)} target="_blank" rel="noreferrer">
        Open on explorer <span aria-hidden="true">-&gt;</span>
      </a>
    </article>
  );
}

function PoolMetric({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="dex-metric">
      <span>{label}</span>
      <strong>{value}</strong>
      {note && <small>{note}</small>}
    </div>
  );
}

function DexPage({ wallet, onNotify, onActionState }: DexPageProps) {
  const [poolAddressInput, setPoolAddressInput] = useState(DEX_CONFIG.spotPoolAddress ?? '');
  const [activePoolAddress, setActivePoolAddress] = useState<string | null>(DEX_CONFIG.spotPoolAddress);
  const [direction, setDirection] = useState<'token0' | 'token1'>('token0');
  const [amountIn, setAmountIn] = useState('');
  const [slippage, setSlippage] = useState('0.5');
  const [quote, setQuote] = useState<bigint | null>(null);
  const [quoteKey, setQuoteKey] = useState<string | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [dismissedDexError, setDismissedDexError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [unresolvedTransactions, setUnresolvedTransactions] = useState<DexUnresolvedTransactions>(readDexUnresolvedTransactions);
  const [currentOperationWalletKey, setCurrentOperationWalletKey] = useState<string | null>(null);
  const writeInFlightRef = useRef(false);
  const writeLockWalletRef = useRef<string | null>(null);
  const operationSequenceRef = useRef(0);
  const currentOperationRef = useRef<DexOperation | null>(null);
  const mountedRef = useRef(true);

  const dex = useDex(activePoolAddress, wallet.address);
  const { readSpotQuote } = dex;
  const pool = dex.pool;
  const registryReady = dex.registryWiring.status === 'healthy';
  const poolReady = pool?.valid === true && pool.hasLiquidity && registryReady;
  const tokenIn = pool && direction === 'token0' ? pool.token0 : pool?.token1 ?? null;
  const tokenOut = pool && direction === 'token0' ? pool.token1 : pool?.token0 ?? null;
  const walletToken = direction === 'token0' ? dex.walletTokens?.token0 ?? null : dex.walletTokens?.token1 ?? null;
  const inputAmount = parseTokenAmount(amountIn, tokenIn?.decimals ?? null);
  const quotePoolKey = pool?.reserves === null || pool?.reserves === undefined
    ? ''
    : `${pool.reserves.reserve0.toString()}:${pool.reserves.reserve1.toString()}:${pool.feePpm?.toString() ?? ''}`;
  const quoteRequestKey = `${activePoolAddress ?? ''}:${direction}:${tokenIn?.address ?? ''}:${amountIn}:${inputAmount?.toString() ?? ''}:${quotePoolKey}`;
  const quoteIsCurrent = quoteRequestKey === (quoteKey ?? '');
  const currentQuote = poolReady && quoteIsCurrent ? quote : null;
  const currentQuoteError = poolReady && quoteIsCurrent ? quoteError : null;
  const currentQuoteLoading = poolReady && inputAmount !== null && (quoteIsCurrent ? quoteLoading : true);
  const slippageBps = parseSlippageBps(slippage);
  const minimumOut = currentQuote !== null && slippageBps !== null
    ? currentQuote * BigInt(10_000 - slippageBps) / 10_000n
    : null;
  const onchainAllowance = walletToken?.allowance ?? null;
  const approvalRequired = inputAmount !== null && (onchainAllowance === null || inputAmount > onchainAllowance);
  const insufficientBalance = wallet.address !== null &&
    walletToken?.balance !== null &&
    walletToken !== null &&
    inputAmount !== null &&
    inputAmount > walletToken.balance;
  const walletReadReady = wallet.address === null || (
    walletToken !== null &&
    walletToken.balance !== null &&
    walletToken.allowance !== null
  );
  const actionReady = poolReady &&
    inputAmount !== null &&
    currentQuote !== null &&
    currentQuote > 0n &&
    minimumOut !== null &&
    slippageBps !== null &&
    walletReadReady &&
    !insufficientBalance;
  const networkState = dex.error || dex.registryWiring.status === 'degraded'
    ? 'degraded'
    : dex.loading || dex.registryWiring.status === 'unavailable'
      ? 'loading'
      : 'live';
  const visibleDexError = dex.error !== null && dex.error !== dismissedDexError ? dex.error : null;
  const pageError = actionError ?? visibleDexError ?? currentQuoteError;
  const currentWalletKey = wallet.address ? walletAddressKey(wallet.address) : null;
  const operationWalletTransaction = currentOperationWalletKey === null
    ? null
    : unresolvedTransactions[currentOperationWalletKey] ?? null;
  const firstStoredTransaction = firstDexUnresolvedTransaction(unresolvedTransactions);
  const unresolvedTransaction = currentWalletKey !== null
    ? unresolvedTransactions[currentWalletKey] ?? operationWalletTransaction ?? firstStoredTransaction
    : operationWalletTransaction ?? firstStoredTransaction;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!poolReady || tokenIn === null || tokenOut === null || inputAmount === null) {
      return;
    }

    const controller = new AbortController();
    void readSpotQuote(tokenIn.address, inputAmount, controller.signal)
      .then((nextQuote) => {
        if (controller.signal.aborted) return;
        setQuoteKey(quoteRequestKey);
        if (nextQuote === null) {
          setQuote(null);
          setQuoteError('The pool did not return a quote for this amount.');
        } else {
          setQuote(nextQuote);
          setQuoteError(null);
        }
        setQuoteLoading(false);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setQuoteKey(quoteRequestKey);
          setQuote(null);
          setQuoteError(error instanceof Error ? error.message : 'Could not update the spot quote.');
          setQuoteLoading(false);
        }
      });

    return () => controller.abort();
  }, [inputAmount, poolReady, quoteRequestKey, readSpotQuote, tokenIn, tokenOut]);

  function notifyError(message: string) {
    setActionError(message);
    onNotify(message, 'error');
  }

  function isCurrentOperation(operation: DexOperation): boolean {
    return currentOperationRef.current?.token === operation.token;
  }

  function updateActionState(operation: DexOperation, label: string | null) {
    if (isCurrentOperation(operation)) onActionState(label);
  }

  function updateBusyAction(operation: DexOperation, label: string | null) {
    if (mountedRef.current && isCurrentOperation(operation)) setBusyAction(label);
  }

  function beginOperation(label: string): DexOperation {
    const operation: DexOperation = {
      token: operationSequenceRef.current + 1,
      label,
      walletAddress: wallet.address,
      walletKey: wallet.address ? walletAddressKey(wallet.address) : null,
      hash: null,
      unresolved: false,
    };
    operationSequenceRef.current = operation.token;
    currentOperationRef.current = operation;
    setCurrentOperationWalletKey(operation.walletKey);
    writeInFlightRef.current = true;
    writeLockWalletRef.current = operation.walletKey;
    return operation;
  }

  function finishOperation(operation: DexOperation) {
    if (!isCurrentOperation(operation) || operation.unresolved) return;
    if (mountedRef.current) setBusyAction(null);
    onActionState(null);
    writeInFlightRef.current = false;
    writeLockWalletRef.current = null;
    currentOperationRef.current = null;
    setCurrentOperationWalletKey(null);
  }

  function handleLoadPool() {
    setActionError(null);
    setQuote(null);
    setAmountIn('');
    const nextAddress = poolAddressInput.trim();
    setActivePoolAddress(nextAddress || null);
    if (nextAddress && !normalizeDexAddress(nextAddress)) {
      setActionError('Enter a valid 20-byte SpotPool address.');
    }
  }

  function handleClearErrors() {
    setActionError(null);
    setQuoteError(null);
    if (dex.error !== null) setDismissedDexError(dex.error);
  }

  async function ensureMonadWallet(): Promise<boolean> {
    if (!wallet.address) {
      const result = await wallet.connect();
      if (result.error) {
        notifyError(result.error);
      } else {
        onNotify('Wallet connected. Run the DEX action again when the wallet is ready.');
      }
      return false;
    }

    if (!wallet.onMonad) {
      try {
        await wallet.switchToMonad();
        onNotify('Monad is ready. Run the DEX action again to sign.');
      } catch (switchError) {
        notifyError(switchError instanceof Error ? switchError.message : 'Switch your wallet to Monad before trading.');
      }
      return false;
    }

    return true;
  }

  async function sendDexTransaction(
    label: string,
    request: { to: string; data: string },
    existingOperation?: DexOperation,
  ): Promise<boolean> {
    if (unresolvedTransaction !== null) {
      notifyError(`Transaction ${formatHash(unresolvedTransaction.hash)} is unresolved. Verify it before sending another DEX action.`);
      return false;
    }
    if (existingOperation === undefined && (writeInFlightRef.current || currentOperationRef.current !== null)) {
      notifyError('Another DEX wallet action is already in progress.');
      return false;
    }

    const operation = existingOperation ?? beginOperation(label);
    if (!isCurrentOperation(operation)) return false;

    const submittedWalletAddress = operation.walletAddress;
    const submittedWalletKey = operation.walletKey;
    if (existingOperation === undefined) {
      updateBusyAction(operation, `${label} / waiting for wallet`);
      updateActionState(operation, `${label} / waiting for wallet`);
    }
    setActionError(null);
    try {
      const submittedHash = await wallet.sendTransaction(request);
      if (!isCurrentOperation(operation)) return false;
      operation.hash = submittedHash;
      if (submittedWalletAddress !== null && submittedWalletKey !== null) {
        const nextUnresolvedTransaction = {
          hash: submittedHash,
          label,
          walletAddress: submittedWalletAddress,
        };
        persistDexUnresolvedTransaction(nextUnresolvedTransaction);
        operation.unresolved = true;
        if (mountedRef.current) {
          setUnresolvedTransactions((transactions) => {
            if (!isCurrentOperation(operation) || !mountedRef.current) return transactions;
            return {
              ...transactions,
              [submittedWalletKey]: nextUnresolvedTransaction,
            };
          });
        }
      }
      updateBusyAction(operation, `${label} / pending`);
      updateActionState(operation, `${label} / pending`);
      onNotify(`${label} submitted ${formatHash(submittedHash)}. Waiting for Monad confirmation.`);
      await wallet.waitForTransaction(submittedHash);
      if (!isCurrentOperation(operation)) return false;

      if (submittedWalletAddress !== null && submittedWalletKey !== null) {
        if (!clearDexUnresolvedTransaction(submittedWalletAddress, submittedHash)) {
          const reloadedTransactions = reloadDexUnresolvedTransactions();
          if (mountedRef.current && reloadedTransactions !== null) setUnresolvedTransactions(reloadedTransactions);
          return false;
        }
        if (mountedRef.current) {
          setUnresolvedTransactions((transactions) => {
            if (!isCurrentOperation(operation)) return transactions;
            const currentTransaction = transactions[submittedWalletKey];
            if (!currentTransaction || !sameTransactionHash(currentTransaction.hash, submittedHash)) return transactions;
            const nextTransactions = { ...transactions };
            delete nextTransactions[submittedWalletKey];
            return nextTransactions;
          });
        }
        operation.unresolved = false;
      }
      onNotify(`${label} confirmed. DEX readings will refresh.`);
      if (mountedRef.current) dex.refresh();
      return true;
    } catch (error: unknown) {
      if (!isCurrentOperation(operation)) return false;
      const message = error instanceof Error ? error.message : `${label} failed.`;
      const submittedHash = operation.hash;
      if (submittedHash !== null && submittedWalletAddress !== null && message !== 'Transaction was mined but reverted on Monad.') {
        operation.unresolved = true;
        const unresolvedRecord = {
          hash: submittedHash,
          label,
          walletAddress: submittedWalletAddress,
        };
        persistDexUnresolvedTransaction(unresolvedRecord);
        if (submittedWalletKey !== null && mountedRef.current) {
          setUnresolvedTransactions((transactions) => {
            if (!isCurrentOperation(operation)) return transactions;
            const currentTransaction = transactions[submittedWalletKey];
            if (currentTransaction && !sameTransactionHash(currentTransaction.hash, submittedHash)) return transactions;
            return { ...transactions, [submittedWalletKey]: unresolvedRecord };
          });
        }
        updateBusyAction(operation, `${label} / receipt verification required`);
        updateActionState(operation, `${label} / receipt verification required`);
        notifyError(`${label} submitted ${formatHash(submittedHash)}, but its receipt could not be verified. Verify it before retrying.`);
      } else if (submittedHash !== null && submittedWalletAddress !== null) {
        if (!clearDexUnresolvedTransaction(submittedWalletAddress, submittedHash)) {
          const reloadedTransactions = reloadDexUnresolvedTransactions();
          if (mountedRef.current && reloadedTransactions !== null) setUnresolvedTransactions(reloadedTransactions);
          return false;
        }
        if (submittedWalletKey !== null && mountedRef.current) {
          setUnresolvedTransactions((transactions) => {
            if (!isCurrentOperation(operation)) return transactions;
            const currentTransaction = transactions[submittedWalletKey];
            if (!currentTransaction || !sameTransactionHash(currentTransaction.hash, submittedHash)) return transactions;
            const nextTransactions = { ...transactions };
            delete nextTransactions[submittedWalletKey];
            return nextTransactions;
          });
        }
        operation.unresolved = false;
        notifyError(message);
      } else {
        notifyError(message);
      }
      return false;
    } finally {
      if (isCurrentOperation(operation) && !operation.unresolved) finishOperation(operation);
    }
  }

  async function handleSwap(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (unresolvedTransaction !== null) {
      notifyError(`Transaction ${formatHash(unresolvedTransaction.hash)} is unresolved. Verify it before sending another DEX action.`);
      return;
    }
    if (writeInFlightRef.current || currentOperationRef.current !== null) {
      notifyError('Another DEX wallet action is already in progress.');
      return;
    }
    if (!poolReady || pool === null || tokenIn === null || tokenOut === null) {
      notifyError('Load a verified SpotPool with nonzero reserves before trading.');
      return;
    }
    if (inputAmount === null || currentQuote === null || currentQuote === 0n || minimumOut === null || slippageBps === null) {
      notifyError('Enter a valid amount and wait for a fresh spot quote.');
      return;
    }
    if (insufficientBalance) {
      notifyError(`The connected wallet does not have enough ${tokenSymbol(tokenIn)}.`);
      return;
    }
    if (!(await ensureMonadWallet())) return;
    const recipient = wallet.address;
    if (!recipient) return;

    if (approvalRequired) {
      const approved = await sendDexTransaction(`Approve ${tokenSymbol(tokenIn)}`, {
        to: tokenIn.address,
        data: encodeErc20Approve(pool.address, inputAmount),
      });
      if (approved) {
        onNotify(`Approval confirmed for ${formatUnits(inputAmount, tokenIn.decimals ?? 18, 4)} ${tokenSymbol(tokenIn)}.`);
      }
      return;
    }

    const swapLabel = `Swap ${tokenSymbol(tokenIn)} for ${tokenSymbol(tokenOut)}`;
    const swapOperation = beginOperation(swapLabel);
    setActionError(null);
    updateBusyAction(swapOperation, `${swapLabel} / simulating`);
    updateActionState(swapOperation, `${swapLabel} / simulating live execution`);
    try {
      let simulatedOutput: bigint | null;
      try {
        simulatedOutput = await dex.simulateSwapExactIn(tokenIn.address, inputAmount, 1n, recipient);
      } catch {
        throw new Error('Final swap simulation failed. Check the live allowance, token balance, and pool state before signing.');
      }
      if (simulatedOutput === null) {
        throw new Error('Final swap simulation failed. Check the live allowance, token balance, and pool state before signing.');
      }
      if (simulatedOutput === 0n) {
        throw new Error('Final swap simulation returned zero output. No swap was signed.');
      }

      const simulatedMinimumOut = simulatedOutput * BigInt(10_000 - slippageBps) / 10_000n;
      if (simulatedMinimumOut === 0n) {
        throw new Error('Final swap output is too small for the selected slippage. No zero-minimum swap will be signed.');
      }

      const swapped = await sendDexTransaction(swapLabel, {
        to: pool.address,
        data: encodeSwapExactIn(tokenIn.address, inputAmount, simulatedMinimumOut, recipient),
      }, swapOperation);
      if (swapped) {
        setAmountIn('');
        setQuote(null);
      }
    } catch (swapError: unknown) {
      if (!isCurrentOperation(swapOperation)) return;
      notifyError(swapError instanceof Error ? swapError.message : 'Final swap simulation failed.');
      finishOperation(swapOperation);
    }
  }

  function handleAcknowledgeUnresolvedTransaction() {
    if (unresolvedTransaction === null) return;

    const acknowledgedKey = walletAddressKey(unresolvedTransaction.walletAddress);
    const currentOperation = currentOperationRef.current;
    const acknowledgesCurrentOperation = currentOperation !== null &&
      currentOperation.walletKey === acknowledgedKey &&
      currentOperation.hash !== null &&
      sameTransactionHash(currentOperation.hash, unresolvedTransaction.hash);

    if (!clearDexUnresolvedTransaction(unresolvedTransaction.walletAddress, unresolvedTransaction.hash)) {
      const reloadedTransactions = reloadDexUnresolvedTransactions();
      if (mountedRef.current && reloadedTransactions !== null) setUnresolvedTransactions(reloadedTransactions);
      return;
    }

    if (acknowledgesCurrentOperation) {
      if (mountedRef.current) setBusyAction(null);
      onActionState(null);
      currentOperationRef.current = null;
      setCurrentOperationWalletKey(null);
      writeInFlightRef.current = false;
      writeLockWalletRef.current = null;
    }
    setUnresolvedTransactions((transactions) => {
      const currentTransaction = transactions[acknowledgedKey];
      if (!currentTransaction || !sameTransactionHash(currentTransaction.hash, unresolvedTransaction.hash)) return transactions;
      const nextTransactions = { ...transactions };
      delete nextTransactions[acknowledgedKey];
      return nextTransactions;
    });
    dex.refresh();
  }

  function handleMaxAmount() {
    if (walletToken?.balance !== null && walletToken !== null && tokenIn?.decimals !== null && tokenIn !== null) {
      setAmountIn(formatUnits(walletToken.balance, tokenIn.decimals, tokenIn.decimals));
    }
  }

  const emptyState = activePoolAddress === null;
  const statusLabel = networkState === 'live' ? 'ONCHAIN / LIVE' : networkState === 'loading' ? 'ONCHAIN / READING' : 'ONCHAIN / DEGRADED';
  const tradeButtonLabel = busyAction ?? (
    !wallet.address
      ? 'Connect wallet'
      : !wallet.onMonad
        ? 'Switch to Monad'
        : approvalRequired
          ? `Approve ${tokenSymbol(tokenIn)}`
          : `Swap ${tokenSymbol(tokenIn)} -> ${tokenSymbol(tokenOut)}`
  );

  return (
    <section className="workspace-section workspace-section--dex" aria-labelledby="dex-page-title">
      <div className="container">
        <div className="dex-heading">
          <div>
            <p className="eyebrow"><span className="eyebrow__line eyebrow__line--ink" />SERIES9 DEX / MONAD 143</p>
            <h1 id="dex-page-title">Trade the signal<br /><em>with receipts.</em></h1>
          </div>
          <div className="dex-heading__aside">
            <p>Read the deployed registry, inspect a SpotPool, and sign only when its tokens and reserves are verifiable.</p>
            <div className={`dex-onchain-status dex-onchain-status--${networkState}`} role="status">
              <span />
              <strong>{statusLabel}</strong>
              <span>{dex.registryWiring.status === 'healthy' ? 'wiring confirmed' : dex.registryWiring.status === 'degraded' ? 'wiring mismatch' : 'reads pending'}</span>
            </div>
          </div>
        </div>

        <div className="dex-toolbar">
          <span>DEX REGISTRY <code>{shortenAddress(DEX_CONTRACTS.registry)}</code></span>
          <span>MAX LP FEE <strong>{formatPpmLimit(dex.registryWiring.maxLpFeeRatePpm)}</strong></span>
          <button className="dex-refresh" type="button" onClick={dex.refresh} disabled={dex.loading}>
            Refresh reads <span aria-hidden="true">/</span>
          </button>
        </div>

        {pageError && (
          <div className="dex-error" role="alert">
            <span><strong>Read or action notice.</strong> {pageError}</span>
            <button type="button" onClick={handleClearErrors}>Clear</button>
          </div>
        )}

        <div className="dex-terminal-layout">
          <section className="dex-terminal" aria-labelledby="dex-terminal-title">
            <div className="dex-terminal__header">
              <div>
                <span className="panel-kicker">SPOT / EXACT INPUT</span>
                <h2 id="dex-terminal-title">Swap terminal</h2>
              </div>
              <span className={`dex-terminal__state${poolReady ? ' dex-terminal__state--ready' : ''}`}>
                {poolReady ? 'READY' : pool?.valid && !registryReady ? 'VERIFY WIRING' : pool?.valid ? 'NO LIQUIDITY' : 'POOL REQUIRED'}
              </span>
            </div>

            <form className="dex-terminal__body" onSubmit={handleSwap}>
              <div className="dex-pool-loader">
                <label htmlFor="dex-pool-address">SpotPool address</label>
                <div className="dex-pool-loader__row">
                  <input
                    id="dex-pool-address"
                    value={poolAddressInput}
                    onChange={(event) => {
                      setPoolAddressInput(event.target.value);
                      setActionError(null);
                    }}
                    placeholder="0x... deployed SpotPool"
                    spellCheck="false"
                    autoComplete="off"
                  />
                  <button className="dex-button dex-button--outline" type="button" onClick={handleLoadPool}>
                    Load
                  </button>
                </div>
                <small>
                  {DEX_CONFIG.spotPoolAddress
                    ? 'Loaded from VITE_DEX_SPOT_POOL_ADDRESS. Paste another deployed pool to inspect it.'
                    : 'No pool is seeded by deployment. Paste a deployed SpotPool address or configure VITE_DEX_SPOT_POOL_ADDRESS.'}
                </small>
              </div>

              {emptyState ? (
                <div className="dex-empty">
                  <span className="dex-empty__mark">09</span>
                  <span className="panel-kicker">NO SEEDED SPOT PAIR</span>
                  <h3>Factories are live. The pair is yours to point at.</h3>
                  <p>The Monad deployment wires the registry, treasury, factories, orderbook, and S9-POS. It does not create or seed a SpotPool. Supply <code>VITE_DEX_SPOT_POOL_ADDRESS</code> or paste a deployed pool above.</p>
                </div>
              ) : pool?.invalidAddress ? (
                <div className="dex-pool-gate dex-pool-gate--error">
                  <strong>Address format rejected.</strong>
                  <p>{pool.error}</p>
                </div>
              ) : !registryReady ? (
                <div className="dex-pool-gate dex-pool-gate--error">
                  <strong>Registry wiring is not verified.</strong>
                  <p>Swap controls stay hidden until the configured registry, pool, Orderbook, and treasury addresses agree on-chain.</p>
                </div>
              ) : !pool?.valid ? (
                <div className="dex-pool-gate">
                  <strong>{pool?.error ?? 'Reading the selected pool.'}</strong>
                  <p>Swap controls stay hidden until DexRegistry confirms the pool and reserves return as a valid tuple.</p>
                </div>
              ) : !pool.hasLiquidity ? (
                <div className="dex-pool-gate">
                  <strong>Pool found, waiting for liquidity.</strong>
                  <p>Both reserve fields must be nonzero before this terminal will expose approval or swap actions.</p>
                </div>
              ) : (
                <>
                  <div className="dex-token-pair">
                    <div className="dex-token-box">
                      <span>YOU SEND</span>
                      <strong>{tokenSymbol(tokenIn)}</strong>
                      <code>{tokenIn ? shortenAddress(tokenIn.address) : EMPTY}</code>
                    </div>
                    <button
                      className="dex-direction-toggle"
                      type="button"
                      aria-label="Reverse token direction"
                      onClick={() => setDirection((current) => current === 'token0' ? 'token1' : 'token0')}
                    >
                      <span aria-hidden="true">&lt;-&gt;</span>
                    </button>
                    <div className="dex-token-box dex-token-box--receive">
                      <span>YOU RECEIVE</span>
                      <strong>{tokenSymbol(tokenOut)}</strong>
                      <code>{tokenOut ? shortenAddress(tokenOut.address) : EMPTY}</code>
                    </div>
                  </div>

                  <label className="dex-amount-field" htmlFor="dex-amount-in">
                    <span><b>Amount in</b><i>Balance {wallet.address ? formatTokenValue(walletToken?.balance ?? null, tokenIn) : 'connect wallet'}</i></span>
                    <div>
                      <input
                        id="dex-amount-in"
                        value={amountIn}
                        onChange={(event) => {
                          setAmountIn(event.target.value);
                          setActionError(null);
                        }}
                        placeholder="0.00"
                        inputMode="decimal"
                        autoComplete="off"
                        aria-describedby="dex-amount-note"
                      />
                      <strong>{tokenSymbol(tokenIn)}</strong>
                      <button type="button" onClick={handleMaxAmount} disabled={walletToken?.balance === null || walletToken === null}>MAX</button>
                    </div>
                    <small id="dex-amount-note">
                      {inputAmount === null && amountIn ? 'Use a decimal amount within the token precision.' : tokenIn ? `${tokenIn.decimals ?? '?'} decimals` : 'Token metadata pending'}
                    </small>
                  </label>

                  <div className="dex-quote-panel" aria-live="polite">
                    <div className="dex-quote-panel__main">
                      <span>ESTIMATED RECEIVED</span>
                      <strong>{currentQuoteLoading ? 'Reading...' : formatTokenValue(currentQuote, tokenOut, 6)}</strong>
                      <small>{tokenOut ? tokenSymbol(tokenOut) : 'quote unavailable'} / pool quote</small>
                    </div>
                    <dl>
                      <div><dt>Minimum received</dt><dd>{formatTokenValue(minimumOut, tokenOut, 6)}</dd></div>
                      <div><dt>Slippage</dt><dd>{slippage}%</dd></div>
                    </dl>
                  </div>
                  <div className="dex-trade-settings">
                    <label htmlFor="dex-slippage">Slippage</label>
                    <select id="dex-slippage" value={slippage} onChange={(event) => setSlippage(event.target.value)}>
                      <option value="0.1">0.1%</option>
                      <option value="0.5">0.5%</option>
                      <option value="1">1%</option>
                      <option value="2">2%</option>
                    </select>
                    <span>{wallet.address ? (walletToken?.allowance === null ? 'Allowance read pending' : approvalRequired ? 'Approval required' : 'Allowance ready') : 'Connect to approve ERC20'}</span>
                  </div>

                  <div className="dex-action-block">
                    <button className="dex-button dex-button--gold dex-button--full" type="submit" disabled={!actionReady || busyAction !== null || unresolvedTransaction !== null || wallet.connecting || wallet.switching}>
                      {tradeButtonLabel} <span aria-hidden="true">-&gt;</span>
                    </button>
                     <p className="dex-trade-note">Final swap execution is simulated against the live allowance and balance before signing. SpotPool writes use ERC20 <code>approve</code> then <code>swapExactIn</code>; native MON must be wrapped first.</p>
                  </div>
                </>
              )}
            </form>

            {unresolvedTransaction && (
              <div className="dex-unresolved" role="alert">
                <span>Receipt status is uncertain for <code>{formatHash(unresolvedTransaction.hash)}</code>. Verify it in your wallet or explorer before continuing.</span>
                <button className="dex-button dex-button--small" type="button" onClick={handleAcknowledgeUnresolvedTransaction}>I verified it</button>
              </div>
            )}
          </section>

          <aside className="dex-rail" aria-label="DEX live readings">
            {pool?.valid ? (
              <section className="dex-telemetry-panel" aria-labelledby="dex-pool-readings-title">
                <div className="dex-panel-heading">
                  <div><span className="panel-kicker">POOL TELEMETRY</span><h2 id="dex-pool-readings-title">Live pool</h2></div>
                  <code>{shortenAddress(pool.address)}</code>
                </div>
                <div className="dex-metric-grid">
                  <PoolMetric label="RESERVE 0" value={formatTokenValue(pool.reserves?.reserve0 ?? null, pool.token0)} note={tokenSymbol(pool.token0)} />
                  <PoolMetric label="RESERVE 1" value={formatTokenValue(pool.reserves?.reserve1 ?? null, pool.token1)} note={tokenSymbol(pool.token1)} />
                  <PoolMetric label="SPOT PRICE" value={formatPriceX18(pool.spotPriceX18 ?? pool.reservePriceX18, pool.token0, pool.token1)} note="token1 per token0" />
                  <PoolMetric label="LP FEE" value={formatFeePpm(pool.feePpm)} note="fixed at pool creation" />
                  <PoolMetric label="PAIR ID" value={pool.pairId ? `${pool.pairId.slice(0, 10)}...` : EMPTY} note="bytes32" />
                </div>
                <div className="dex-pool-reading-note">
                  <span className={`dex-reading-dot${pool.hasLiquidity ? ' dex-reading-dot--good' : ''}`} />
                  {pool.hasLiquidity ? 'Reserves are nonzero. Quote reads are enabled.' : 'Pool is deployed but not seeded.'}
                </div>
              </section>
            ) : (
              <section className="dex-telemetry-panel dex-telemetry-panel--quiet">
                <span className="panel-kicker">POOL TELEMETRY</span>
                <h2>Nothing invented here.</h2>
                <p>Live cards appear only after a real SpotPool, token metadata, pair ID, and reserve tuple are read from Monad.</p>
              </section>
            )}

            <section className="dex-orderbook-panel" aria-labelledby="dex-orderbook-title">
              <div className="dex-panel-heading">
                <div><span className="panel-kicker">ORDERBOOK / SAME PAIR</span><h2 id="dex-orderbook-title">Best levels</h2></div>
                <span className="dex-panel-stamp">{dex.orderbook?.bookConfig ? 'READ' : 'WAITING'}</span>
              </div>
              {pool?.valid && dex.orderbook ? (
                <>
                  <div className="dex-book-levels">
                    <div><span>BEST BID</span><strong>{formatLevelPrice(dex.orderbook.bestBid?.priceX18 ?? null, pool)}</strong><small>{formatTokenValue(dex.orderbook.bestBid?.totalBase ?? null, pool.token0)} {tokenSymbol(pool.token0)}</small></div>
                    <div><span>BEST ASK</span><strong>{formatLevelPrice(dex.orderbook.bestAsk?.priceX18 ?? null, pool)}</strong><small>{formatTokenValue(dex.orderbook.bestAsk?.totalBase ?? null, pool.token0)} {tokenSymbol(pool.token0)}</small></div>
                  </div>
                  <div className="dex-book-config">
                    <span>BOOK CONFIG</span>
                    <strong>{dex.orderbook.bookConfig?.initialized ? 'INITIALIZED' : dex.orderbook.bookConfig ? 'EMPTY' : 'UNAVAILABLE'}</strong>
                    <small>{dex.orderbook.bookConfig?.tickSize === undefined ? 'Pair config not decoded.' : `Tick ${dex.orderbook.bookConfig.tickSize.toString()}`}</small>
                  </div>
                </>
              ) : (
                <p className="dex-panel-empty">Orderbook levels wait for a verified pool pair ID.</p>
              )}
            </section>
          </aside>
        </div>

        <section className="dex-infrastructure" aria-labelledby="dex-infrastructure-title">
          <div className="dex-section-heading">
            <div><span className="eyebrow"><span className="eyebrow__line eyebrow__line--ink" />DEPLOYED WIRING</span><h2 id="dex-infrastructure-title">The machine<br /><em>behind the market.</em></h2></div>
            <p>Every address below is the supplied Monad mainnet deployment. Registry reads are compared against these anchors; mismatches stay visible.</p>
          </div>
          <div className="dex-infra-grid">
            <InfrastructureCard label="DexRegistry" address={DEX_CONTRACTS.registry} note="01 / REGISTRY" detail={dex.registryWiring.status === 'healthy' ? 'wiring confirmed' : 'read status visible above'} />
            <InfrastructureCard label="ProtocolTreasury" address={DEX_CONTRACTS.protocolTreasury} note="02 / TREASURY" detail="protocol fee sink" />
            <InfrastructureCard label="Orderbook" address={DEX_CONTRACTS.orderbook} note="03 / BOOK" detail={dex.registryWiring.infraRegistry.orderbook ? `registry ${shortenAddress(dex.registryWiring.infraRegistry.orderbook)}` : 'registry read pending'} />
            <InfrastructureCard label="SpotPoolFactory" address={DEX_CONTRACTS.spotPoolFactory} note="04 / SPOT" detail="pool deployment" />
            <InfrastructureCard label="PerpPoolFactory" address={DEX_CONTRACTS.perpPoolFactory} note="05 / PERP" detail="perpetual deployment" />
            <InfrastructureCard
              label="DexPositionManager"
              address={DEX_CONTRACTS.positionManager}
              note="06 / S9-POS"
              detail={dex.positionManager.symbol ? `${dex.positionManager.symbol} / next #${dex.positionManager.nextTokenId?.toString() ?? EMPTY}` : 'position NFT metadata pending'}
            />
          </div>
          <div className="dex-s9pos-note">
            <span>S9-POS</span>
            <p><strong>DexPositionManager is an ERC-721 position wrapper.</strong> It custodies LP shares and is not the SpotPool swap target. Swaps approve the selected token to the selected SpotPool only.</p>
          </div>
        </section>
      </div>
    </section>
  );
}

export default DexPage;
