import { useCallback, useEffect, useRef, useState } from 'react';
import { MONAD } from './chain.ts';

/** EIP-1193 provider surface, narrowed to what this site calls. */
type ProviderEventHandler = (...args: unknown[]) => void;

type Eip1193Provider = {
  request: (args: { readonly method: string; readonly params?: readonly unknown[] | object }) => Promise<unknown>;
  on?: (event: string, handler: ProviderEventHandler) => void;
  removeListener?: (event: string, handler: ProviderEventHandler) => void;
};

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

/** Outcome of a connect attempt, returned so callers can report it without an effect. */
export type ConnectResult = { address: string | null; error: string | null };

export type SendTransactionRequest = {
  to: string;
  data?: string;
  value?: bigint | string;
};

export type TransactionReceipt = {
  transactionHash?: string;
  blockNumber?: string;
  status?: string;
  [key: string]: unknown;
};

export type WaitForTransactionOptions = {
  timeoutMs?: number;
  pollIntervalMs?: number;
};

type ProviderSession = {
  accounts: string[];
  chainId: bigint;
};

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const TRANSACTION_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const QUANTITY_PATTERN = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;
const TRANSACTION_DATA_PATTERN = /^0x(?:[0-9a-fA-F]{2})*$/;
const DEFAULT_WAIT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 1_500;
const RECEIPT_REQUEST_TIMEOUT_MS = 12_000;
const DISCONNECTED_MESSAGE = 'Wallet disconnected. Reconnect your wallet to continue.';
const NO_ACCOUNT_MESSAGE = 'No wallet account is available. Unlock or select an account in your wallet.';
const SESSION_CHANGED_MESSAGE = 'Wallet session changed during the transaction request. Verify the transaction before retrying.';

export type WalletState = {
  available: boolean;
  address: string | null;
  chainId: bigint | null;
  onMonad: boolean;
  connecting: boolean;
  switching: boolean;
  error: string | null;
  connect: () => Promise<ConnectResult>;
  disconnect: () => void;
  switchToMonad: () => Promise<void>;
  estimateTransactionFee: (request: SendTransactionRequest) => Promise<bigint>;
  sendTransaction: (request: SendTransactionRequest) => Promise<string>;
  waitForTransaction: (hash: string, options?: WaitForTransactionOptions) => Promise<TransactionReceipt>;
};

function getProvider(): Eip1193Provider | null {
  return typeof window === 'undefined' ? null : (window.ethereum ?? null);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readProviderErrorRecords(error: unknown): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  const pending: unknown[] = [error];
  const visited = new Set<Record<string, unknown>>();

  while (pending.length > 0) {
    const candidate = pending.shift();
    if (!isRecord(candidate) || visited.has(candidate)) continue;

    visited.add(candidate);
    records.push(candidate);
    pending.push(candidate.data, candidate.originalError);
  }

  return records;
}

function readProviderCodes(error: unknown): number[] {
  return readProviderErrorRecords(error)
    .map((record) => record.code)
    .filter((code): code is number => typeof code === 'number' && Number.isInteger(code));
}

function readProviderCode(error: unknown): number | null {
  const codes = readProviderCodes(error);
  return codes.find((code) => code !== -32603) ?? codes[0] ?? null;
}

function readProviderMessage(error: unknown): string | null {
  if (typeof error === 'string' && error.trim()) return error.trim();
  for (const record of readProviderErrorRecords(error)) {
    if (typeof record.message === 'string' && record.message.trim()) return record.message.trim();
  }
  return null;
}

function normalizeProviderError(error: unknown, fallback: string): string {
  switch (readProviderCode(error)) {
    case 4001:
      return 'Request rejected by your wallet.';
    case 4100:
      return 'Wallet authorization is required for this request.';
    case 4200:
      return 'Your wallet does not support this request.';
    case 4900:
      return DISCONNECTED_MESSAGE;
    case 4901:
      return 'Wallet is not connected to the requested chain.';
    case -32002:
      return 'A wallet request is already pending. Check your wallet.';
    case -32003:
      return 'The transaction was rejected by your wallet.';
    default:
      return readProviderMessage(error) ?? fallback;
  }
}

function readAccounts(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((account): account is string => typeof account === 'string' && ADDRESS_PATTERN.test(account))) {
    throw new Error(`${label} returned an invalid account list.`);
  }
  return value;
}

function readQuantity(value: unknown, label: string): bigint {
  if (typeof value !== 'string' || !QUANTITY_PATTERN.test(value)) {
    throw new Error(`${label} returned an invalid hexadecimal quantity.`);
  }

  try {
    return BigInt(value);
  } catch {
    throw new Error(`${label} returned an invalid hexadecimal quantity.`);
  }
}

function readChainId(value: unknown, label: string): bigint {
  return readQuantity(value, label);
}

function isTransactionHash(value: unknown): value is string {
  return typeof value === 'string' && TRANSACTION_HASH_PATTERN.test(value) && !/^0+$/.test(value.slice(2));
}

function readTransactionReceipt(value: unknown, expectedHash: string): TransactionReceipt {
  if (!isRecord(value)) throw new Error('Wallet returned a malformed transaction receipt.');

  if (!isTransactionHash(value.transactionHash)) {
    throw new Error('Wallet returned a receipt with an invalid transaction hash.');
  }
  if (value.transactionHash.toLowerCase() !== expectedHash.toLowerCase()) {
    throw new Error('Wallet returned a receipt for a different transaction.');
  }
  if (typeof value.blockNumber !== 'string' || !QUANTITY_PATTERN.test(value.blockNumber)) {
    throw new Error('Wallet returned a receipt with an invalid block number.');
  }
  if (value.logs !== undefined && !Array.isArray(value.logs)) {
    throw new Error('Wallet returned a receipt with invalid logs.');
  }
  if (value.status === '0x0' || value.status === '0x00') {
    throw new Error('Transaction was mined but reverted on Monad.');
  }
  if (value.status !== '0x1') {
    throw new Error('Wallet returned a receipt with an invalid status.');
  }

  return value;
}

async function readProviderSession(provider: Eip1193Provider): Promise<ProviderSession> {
  const accounts = readAccounts(await provider.request({ method: 'eth_accounts' }), 'eth_accounts');
  const chainId = readChainId(await provider.request({ method: 'eth_chainId' }), 'eth_chainId');
  return { accounts, chainId };
}

function isSameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function isUnknownChainError(error: unknown): boolean {
  if (readProviderCodes(error).includes(4902)) return true;

  return readProviderErrorRecords(error).some((record) => {
    if (typeof record.message !== 'string') return false;
    const message = record.message.toLowerCase();

    return (
      message.includes('unknown chain') ||
      message.includes('unrecognized chain') ||
      message.includes('unrecognised chain') ||
      /chain(?: id)?[^.]*not (?:added|recognized|recognised|found|supported)/.test(message) ||
      /does not recognize[^.]*chain/.test(message) ||
      /chain[^.]*is not available/.test(message)
    );
  });
}

function encodeQuantity(value: bigint | string): string {
  let numeric: bigint;
  try {
    if (typeof value === 'bigint') {
      numeric = value;
    } else if (/^(?:\d+|0x[0-9a-fA-F]+)$/.test(value)) {
      numeric = BigInt(value);
    } else {
      throw new Error('invalid transaction value');
    }
  } catch {
    throw new Error('Transaction value must be a non-negative integer.');
  }

  if (numeric < 0n) throw new Error('Transaction value must be a non-negative integer.');
  return `0x${numeric.toString(16)}`;
}

function validateTransactionData(value: string | undefined): void {
  if (value !== undefined && !TRANSACTION_DATA_PATTERN.test(value)) {
    throw new Error('Transaction calldata must be 0x-prefixed even-length hexadecimal bytes.');
  }
}

function decodeRpcQuantity(value: unknown, label: string): bigint {
  return readQuantity(value, label);
}

function withTimeout<T>(request: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = globalThis.setTimeout(() => {
      reject(new Error('Timed out reading the transaction receipt.'));
    }, timeoutMs);

    void request.then(
      (value) => {
        globalThis.clearTimeout(timeoutId);
        resolve(value);
      },
      (error: unknown) => {
        globalThis.clearTimeout(timeoutId);
        reject(error);
      },
    );
  });
}

/** Wallet connection over the single injected EIP-1193 provider. */
export function useWallet(): WalletState {
  const [address, setAddress] = useState<string | null>(null);
  const [chainId, setChainId] = useState<bigint | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lifecycleVersionRef = useRef(0);
  const disconnectVersionRef = useRef<number | null>(null);
  const connectInFlightRef = useRef<Promise<ConnectResult> | null>(null);
  const switchInFlightRef = useRef<Promise<void> | null>(null);
  const connectGenerationRef = useRef(0);
  const switchGenerationRef = useRef(0);

  const advanceLifecycle = useCallback((isDisconnect = false): number => {
    lifecycleVersionRef.current += 1;
    if (isDisconnect) disconnectVersionRef.current = lifecycleVersionRef.current;
    return lifecycleVersionRef.current;
  }, []);

  const invalidateOperations = useCallback(
    (disconnectError: string | null): void => {
      advanceLifecycle(true);
      connectGenerationRef.current += 1;
      switchGenerationRef.current += 1;
      connectInFlightRef.current = null;
      switchInFlightRef.current = null;
      setConnecting(false);
      setSwitching(false);
      setAddress(null);
      setChainId(null);
      setError(disconnectError);
    },
    [advanceLifecycle],
  );

  const available = typeof window !== 'undefined' && Boolean(window.ethereum);

  // Restore an already-authorized session and track wallet-side changes.
  useEffect(() => {
    const provider = getProvider();
    if (!provider) return;

    let active = true;

    const reconcileProviderSession = async (
      version: number,
      fallback: string,
      preservedField: 'accounts' | 'chainId' | null = null,
    ): Promise<void> => {
      try {
        const session = await readProviderSession(provider);
        if (!active || lifecycleVersionRef.current !== version || disconnectVersionRef.current !== null) return;

        if (preservedField !== 'accounts') setAddress(session.accounts[0] ?? null);
        if (preservedField !== 'chainId') setChainId(session.chainId);
        setError(null);
      } catch (sessionError) {
        if (!active || lifecycleVersionRef.current !== version || disconnectVersionRef.current !== null) return;

        if (preservedField !== 'accounts') setAddress(null);
        if (preservedField !== 'chainId') setChainId(null);
        setError(normalizeProviderError(sessionError, fallback));
      }
    };

    const handleAccountsChanged: ProviderEventHandler = (...args) => {
      if (!active) return;
      const version = advanceLifecycle();
      try {
        const accounts = readAccounts(args[0], 'accountsChanged');
        if (!active || lifecycleVersionRef.current !== version || disconnectVersionRef.current !== null) return;
        setAddress(accounts[0] ?? null);
      } catch (eventError) {
        if (!active || lifecycleVersionRef.current !== version || disconnectVersionRef.current !== null) return;
        setAddress(null);
        setError(normalizeProviderError(eventError, 'Wallet returned an invalid provider session.'));
        return;
      }
      void reconcileProviderSession(version, 'Wallet returned an invalid provider session.', 'accounts');
    };

    const handleChainChanged: ProviderEventHandler = (...args) => {
      if (!active) return;
      const version = advanceLifecycle();
      try {
        const nextChainId = readChainId(args[0], 'chainChanged');
        if (!active || lifecycleVersionRef.current !== version || disconnectVersionRef.current !== null) return;
        setChainId(nextChainId);
      } catch (eventError) {
        if (!active || lifecycleVersionRef.current !== version || disconnectVersionRef.current !== null) return;
        setChainId(null);
        setError(normalizeProviderError(eventError, 'Wallet returned an invalid provider session.'));
        return;
      }
      void reconcileProviderSession(version, 'Wallet returned an invalid provider session.', 'chainId');
    };

    const handleDisconnect: ProviderEventHandler = (...args) => {
      if (!active) return;
      const fallback = normalizeProviderError(args[0], DISCONNECTED_MESSAGE);
      invalidateOperations(fallback);
    };

    const handleConnect: ProviderEventHandler = () => {
      if (!active) return;
      const version = advanceLifecycle();
      if (disconnectVersionRef.current !== null) return;
      void reconcileProviderSession(version, 'Wallet returned an invalid provider session.');
    };

    provider.on?.('accountsChanged', handleAccountsChanged);
    provider.on?.('chainChanged', handleChainChanged);
    provider.on?.('disconnect', handleDisconnect);
    provider.on?.('connect', handleConnect);

    void (async () => {
      const readVersion = lifecycleVersionRef.current;
      try {
        const session = await readProviderSession(provider);
        if (!active || lifecycleVersionRef.current !== readVersion || disconnectVersionRef.current !== null) return;

        setAddress(session.accounts[0] ?? null);
        setChainId(session.chainId);
      } catch {
        // A locked or unavailable wallet is not an error worth surfacing on load.
      }
    })();

    return () => {
      active = false;
      provider.removeListener?.('accountsChanged', handleAccountsChanged);
      provider.removeListener?.('chainChanged', handleChainChanged);
      provider.removeListener?.('disconnect', handleDisconnect);
      provider.removeListener?.('connect', handleConnect);
    };
  }, [advanceLifecycle, invalidateOperations]);

  const switchToMonad = useCallback((): Promise<void> => {
    const inFlight = switchInFlightRef.current;
    if (inFlight) return inFlight;

    const disconnectVersionAtStart = disconnectVersionRef.current;
    const switchGeneration = switchGenerationRef.current + 1;
    switchGenerationRef.current = switchGeneration;
    setSwitching(true);
    const promise = (async () => {
      const switchVersion = lifecycleVersionRef.current;
      const isCurrentOperation = () => switchGenerationRef.current === switchGeneration;
      const isDisconnectInvalidated = () => {
        const disconnectVersion = disconnectVersionRef.current;
        return disconnectVersion !== null && (disconnectVersionAtStart === null || disconnectVersion > disconnectVersionAtStart);
      };
      let verifiedChainId: bigint | null = null;

      try {
        const provider = getProvider();
        if (!provider) {
          const message = 'No wallet detected. Install a Monad-compatible wallet first.';
          setError(message);
          throw new Error(message);
        }

        try {
          await provider.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: MONAD.idHex }],
          });
          if (!isCurrentOperation() || isDisconnectInvalidated()) {
            throw new Error(DISCONNECTED_MESSAGE);
          }
        } catch (switchError) {
          if (!isCurrentOperation() || isDisconnectInvalidated()) {
            throw new Error(DISCONNECTED_MESSAGE);
          }
          // Only the standard unknown-chain response, or a clearly equivalent message, permits adding a chain.
          if (!isUnknownChainError(switchError)) throw switchError;

          await provider.request({
            method: 'wallet_addEthereumChain',
            params: [
              {
                chainId: MONAD.idHex,
                chainName: MONAD.name,
                nativeCurrency: MONAD.nativeCurrency,
                rpcUrls: [MONAD.rpcUrl],
                blockExplorerUrls: [MONAD.explorer],
              },
            ],
          });
          if (!isCurrentOperation() || isDisconnectInvalidated()) {
            throw new Error(DISCONNECTED_MESSAGE);
          }

          await provider.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: MONAD.idHex }],
          });
          if (!isCurrentOperation() || isDisconnectInvalidated()) {
            throw new Error(DISCONNECTED_MESSAGE);
          }
        }

        verifiedChainId = readChainId(await provider.request({ method: 'eth_chainId' }), 'eth_chainId');
        if (!isCurrentOperation() || isDisconnectInvalidated()) {
          throw new Error(DISCONNECTED_MESSAGE);
        }
        if (lifecycleVersionRef.current === switchVersion) setChainId(verifiedChainId);
        if (verifiedChainId !== BigInt(MONAD.id)) {
          throw new Error(`Wallet is on chain ${verifiedChainId}, not ${MONAD.name}.`);
        }
        if (!isCurrentOperation() || isDisconnectInvalidated()) {
          throw new Error(DISCONNECTED_MESSAGE);
        }
        if (lifecycleVersionRef.current === switchVersion) setError(null);
      } catch (switchError) {
        const invalidated = !isCurrentOperation() || isDisconnectInvalidated();
        const message = invalidated
          ? DISCONNECTED_MESSAGE
          : normalizeProviderError(switchError, `Could not switch to ${MONAD.name}.`);
        if (!invalidated && lifecycleVersionRef.current === switchVersion) {
          setChainId(verifiedChainId);
          setError(message);
        }
        throw new Error(message);
      } finally {
        if (switchGenerationRef.current === switchGeneration) setSwitching(false);
      }
    })();

    if (switchGenerationRef.current === switchGeneration) {
      switchInFlightRef.current = promise;
    }
    const clearInFlight = () => {
      if (switchInFlightRef.current === promise) switchInFlightRef.current = null;
    };
    void promise.then(clearInFlight, clearInFlight);
    return promise;
  }, []);

  const connect = useCallback((): Promise<ConnectResult> => {
    const inFlight = connectInFlightRef.current;
    if (inFlight) return inFlight;

    const disconnectVersionAtStart = disconnectVersionRef.current;
    const connectGeneration = connectGenerationRef.current + 1;
    connectGenerationRef.current = connectGeneration;
    const promise = (async (): Promise<ConnectResult> => {
      const provider = getProvider();
      if (!provider) {
        const message = 'No wallet detected. Install MetaMask or another Monad-compatible wallet.';
        setError(message);
        return { address: null, error: message };
      }

      const connectVersion = advanceLifecycle();
      const isCurrentOperation = () => connectGenerationRef.current === connectGeneration;
      const isCurrent = () => isCurrentOperation() && lifecycleVersionRef.current === connectVersion;
      const isDisconnectInvalidated = () => {
        const disconnectVersion = disconnectVersionRef.current;
        return disconnectVersion !== null && (disconnectVersionAtStart === null || disconnectVersion > disconnectVersionAtStart);
      };

      setConnecting(true);
      setError(null);

      let connectedAddress: string | null = null;
      let knownChainId: bigint | null = null;
      let finalSessionReadStarted = false;
      let finalSessionReadCompleted = false;

      try {
        const requestedAccounts = readAccounts(
          await provider.request({ method: 'eth_requestAccounts' }),
          'eth_requestAccounts',
        );
        if (!isCurrentOperation() || isDisconnectInvalidated()) {
          throw new Error(DISCONNECTED_MESSAGE);
        }
        if (requestedAccounts.length === 0) {
          if (isCurrent()) {
            setAddress(null);
            setChainId(null);
          }
          throw new Error(NO_ACCOUNT_MESSAGE);
        }

        // Read the passive session after permission is granted instead of trusting stale local state.
        const sessionReadVersion = lifecycleVersionRef.current;
        const session = await readProviderSession(provider);
        if (!isCurrentOperation() || isDisconnectInvalidated()) {
          throw new Error(DISCONNECTED_MESSAGE);
        }
        connectedAddress = session.accounts[0] ?? null;
        knownChainId = session.chainId;
        if (
          isCurrent() &&
          lifecycleVersionRef.current === sessionReadVersion &&
          disconnectVersionAtStart === null &&
          !isDisconnectInvalidated()
        ) {
          setAddress(connectedAddress);
          setChainId(session.chainId);
        }

        if (!connectedAddress) {
          if (isCurrent() && !isDisconnectInvalidated()) setAddress(null);
          throw new Error(NO_ACCOUNT_MESSAGE);
        }

        if (session.chainId !== BigInt(MONAD.id)) {
          await switchToMonad();
        }
        if (!isCurrentOperation() || isDisconnectInvalidated()) {
          throw new Error(DISCONNECTED_MESSAGE);
        }

        finalSessionReadStarted = true;
        const finalSessionReadVersion = lifecycleVersionRef.current;
        let finalSession = await readProviderSession(provider);
        finalSessionReadCompleted = true;
        if (!isCurrentOperation() || isDisconnectInvalidated()) {
          throw new Error(DISCONNECTED_MESSAGE);
        }
        connectedAddress = finalSession.accounts[0] ?? null;
        knownChainId = finalSession.chainId;

        // A provider event can land while the final session read is pending. Re-read once so the
        // connect result reflects the session that is current after that event.
        if (lifecycleVersionRef.current !== finalSessionReadVersion || !isCurrent()) {
          const finalSessionReReadVersion = lifecycleVersionRef.current;
          const reReadSession = await readProviderSession(provider);
          const reReadLifecycleChanged = lifecycleVersionRef.current !== finalSessionReReadVersion;
          if (isDisconnectInvalidated() || !isCurrentOperation()) {
            throw new Error(DISCONNECTED_MESSAGE);
          }
          if (reReadLifecycleChanged) throw new Error(SESSION_CHANGED_MESSAGE);
          finalSession = reReadSession;
          connectedAddress = finalSession.accounts[0] ?? null;
          knownChainId = finalSession.chainId;
        }

        if (!isCurrentOperation() || isDisconnectInvalidated()) {
          if (isCurrentOperation()) {
            setAddress(null);
            setChainId(null);
          }
          throw new Error(DISCONNECTED_MESSAGE);
        }

        if (!connectedAddress) {
          throw new Error(NO_ACCOUNT_MESSAGE);
        }
        if (finalSession.chainId !== BigInt(MONAD.id)) {
          throw new Error(`Wallet is on chain ${finalSession.chainId}, not ${MONAD.name}.`);
        }

        setAddress(connectedAddress);
        setChainId(finalSession.chainId);
        setError(null);
        // A provider/local disconnect remains invalidating until this explicit connect has
        // verified both the current account and the required chain.
        disconnectVersionRef.current = null;
        return { address: connectedAddress, error: null };
      } catch (connectError) {
        const invalidated = !isCurrentOperation() || isDisconnectInvalidated();
        const message = invalidated
          ? DISCONNECTED_MESSAGE
          : normalizeProviderError(connectError, 'Could not connect to the wallet.');
        if (isCurrentOperation()) {
          if (invalidated || disconnectVersionAtStart !== null) {
            setAddress(null);
            setChainId(null);
          } else if (isCurrent() && finalSessionReadStarted && !finalSessionReadCompleted) {
            setChainId(null);
          } else if (isCurrent()) {
            setChainId(knownChainId);
          }
          if (isCurrent() || disconnectVersionAtStart !== null) setError(message);
        }
        return {
          address: invalidated || disconnectVersionAtStart !== null ? null : connectedAddress,
          error: message,
        };
      } finally {
        if (connectGenerationRef.current === connectGeneration) setConnecting(false);
      }
    })();

    if (connectGenerationRef.current === connectGeneration) {
      connectInFlightRef.current = promise;
    }
    const clearInFlight = () => {
      if (connectInFlightRef.current === promise) connectInFlightRef.current = null;
    };
    void promise.then(clearInFlight, clearInFlight);
    return promise;
  }, [advanceLifecycle, switchToMonad]);

  const verifyWriteSession = useCallback(
    async (provider: Eip1193Provider, expectedAddress: string, action: string): Promise<string> => {
      if (disconnectVersionRef.current !== null) {
        setError(DISCONNECTED_MESSAGE);
        throw new Error(DISCONNECTED_MESSAGE);
      }
      const verificationVersion = lifecycleVersionRef.current;
      let session: ProviderSession;
      try {
        session = await readProviderSession(provider);
      } catch (sessionError) {
        if (disconnectVersionRef.current !== null) {
          setError(DISCONNECTED_MESSAGE);
          throw new Error(DISCONNECTED_MESSAGE);
        }
        if (lifecycleVersionRef.current !== verificationVersion) {
          setError(SESSION_CHANGED_MESSAGE);
          throw new Error(SESSION_CHANGED_MESSAGE);
        }
        const message = normalizeProviderError(sessionError, `Could not verify the wallet before ${action}.`);
        setAddress(null);
        setChainId(null);
        setError(message);
        throw new Error(message);
      }

      if (disconnectVersionRef.current !== null) {
        setError(DISCONNECTED_MESSAGE);
        throw new Error(DISCONNECTED_MESSAGE);
      }
      if (lifecycleVersionRef.current !== verificationVersion) {
        setError(SESSION_CHANGED_MESSAGE);
        throw new Error(SESSION_CHANGED_MESSAGE);
      }

      const currentAddress = session.accounts[0] ?? null;
      setChainId(session.chainId);

      if (!currentAddress) {
        const message = `Connect a wallet before ${action}.`;
        setAddress(null);
        setError(message);
        throw new Error(message);
      }

      setAddress(currentAddress);
      if (!isSameAddress(currentAddress, expectedAddress)) {
        const message = 'Wallet account changed. Retry the transaction.';
        setError(message);
        throw new Error(message);
      }
      if (session.chainId !== BigInt(MONAD.id)) {
        const message = `Switch your wallet to ${MONAD.name} before ${action}.`;
        setError(message);
        throw new Error(message);
      }

      setError(null);
      return currentAddress;
    },
    [],
  );

  const sendTransaction = useCallback(async (request: SendTransactionRequest): Promise<string> => {
    if (disconnectVersionRef.current !== null) {
      setError(DISCONNECTED_MESSAGE);
      throw new Error(DISCONNECTED_MESSAGE);
    }
    const provider = getProvider();
    if (!provider) throw new Error('No wallet detected. Install a Monad-compatible wallet first.');
    if (!address) throw new Error('Connect a wallet before sending a transaction.');
    if (!ADDRESS_PATTERN.test(request.to)) throw new Error('Transaction target is not a valid address.');
    validateTransactionData(request.data);
    const encodedValue = request.value === undefined ? undefined : encodeQuantity(request.value);
    const preflightVersion = lifecycleVersionRef.current;

    const freshAddress = await verifyWriteSession(provider, address, 'sending a transaction');
    if (disconnectVersionRef.current !== null) {
      setError(DISCONNECTED_MESSAGE);
      throw new Error(DISCONNECTED_MESSAGE);
    }
    if (lifecycleVersionRef.current !== preflightVersion) {
      setError(SESSION_CHANGED_MESSAGE);
      throw new Error(SESSION_CHANGED_MESSAGE);
    }

    const transaction: Record<string, string> = {
      from: freshAddress,
      to: request.to,
    };
    if (request.data !== undefined) transaction.data = request.data;
    if (encodedValue !== undefined) transaction.value = encodedValue;

    try {
      const hash = await provider.request({ method: 'eth_sendTransaction', params: [transaction] });
      if (!isTransactionHash(hash)) throw new Error('Wallet returned an invalid transaction hash.');
      return hash;
    } catch (sendError) {
      if (disconnectVersionRef.current !== null) throw new Error(DISCONNECTED_MESSAGE);
      throw new Error(normalizeProviderError(sendError, 'Transaction request failed.'));
    }
  }, [address, verifyWriteSession]);

  const estimateTransactionFee = useCallback(async (request: SendTransactionRequest): Promise<bigint> => {
    if (disconnectVersionRef.current !== null) {
      setError(DISCONNECTED_MESSAGE);
      throw new Error(DISCONNECTED_MESSAGE);
    }
    const provider = getProvider();
    if (!provider) throw new Error('No wallet detected. Install a Monad-compatible wallet first.');
    if (!address) throw new Error('Connect a wallet before estimating transaction fees.');
    if (!ADDRESS_PATTERN.test(request.to)) throw new Error('Transaction target is not a valid address.');
    validateTransactionData(request.data);
    const encodedValue = request.value === undefined ? undefined : encodeQuantity(request.value);
    const preflightVersion = lifecycleVersionRef.current;

    const freshAddress = await verifyWriteSession(provider, address, 'estimating transaction fees');
    if (disconnectVersionRef.current !== null) {
      setError(DISCONNECTED_MESSAGE);
      throw new Error(DISCONNECTED_MESSAGE);
    }
    if (lifecycleVersionRef.current !== preflightVersion) {
      setError(SESSION_CHANGED_MESSAGE);
      throw new Error(SESSION_CHANGED_MESSAGE);
    }

    const transaction: Record<string, string> = {
      from: freshAddress,
      to: request.to,
    };
    if (request.data !== undefined) transaction.data = request.data;
    if (encodedValue !== undefined) transaction.value = encodedValue;

    try {
      const [gasResult, gasPriceResult] = await Promise.all([
        provider.request({ method: 'eth_estimateGas', params: [transaction] }),
        provider.request({ method: 'eth_gasPrice', params: [] }),
      ]);
      const gas = decodeRpcQuantity(gasResult, 'eth_estimateGas');
      const gasPrice = decodeRpcQuantity(gasPriceResult, 'eth_gasPrice');
      if (disconnectVersionRef.current !== null) {
        setError(DISCONNECTED_MESSAGE);
        throw new Error(DISCONNECTED_MESSAGE);
      }
      if (lifecycleVersionRef.current !== preflightVersion) {
        setError(SESSION_CHANGED_MESSAGE);
        throw new Error(SESSION_CHANGED_MESSAGE);
      }
      return gas * gasPrice;
    } catch (estimateError) {
      if (disconnectVersionRef.current !== null) throw new Error(DISCONNECTED_MESSAGE);
      if (lifecycleVersionRef.current !== preflightVersion) throw new Error(SESSION_CHANGED_MESSAGE);
      if (estimateError instanceof Error && /returned an invalid (?:hexadecimal )?quantity\.$/.test(estimateError.message)) {
        throw estimateError;
      }
      throw new Error(`Could not estimate transaction fee: ${normalizeProviderError(estimateError, 'Fee estimation failed.')}`);
    }
  }, [address, verifyWriteSession]);

  const waitForTransaction = useCallback(
    async (hash: string, options: WaitForTransactionOptions = {}): Promise<TransactionReceipt> => {
      const provider = getProvider();
      if (!provider) throw new Error('No wallet detected while waiting for the transaction.');
      if (!isTransactionHash(hash)) throw new Error('Invalid transaction hash.');

      const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
      const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
        throw new Error('Transaction wait timeout must be a positive safe integer.');
      }
      if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs <= 0) {
        throw new Error('Transaction poll interval must be a positive safe integer.');
      }

      const startedAt = Date.now();

      while (Date.now() - startedAt < timeoutMs) {
        let receiptResult: unknown;
        try {
          receiptResult = await withTimeout(
            provider.request({ method: 'eth_getTransactionReceipt', params: [hash] }),
            RECEIPT_REQUEST_TIMEOUT_MS,
          );
        } catch (receiptError) {
          throw new Error(normalizeProviderError(receiptError, 'Could not read the transaction receipt.'));
        }

        if (receiptResult !== null) return readTransactionReceipt(receiptResult, hash);

        const remainingMs = timeoutMs - (Date.now() - startedAt);
        if (remainingMs <= 0) break;
        await new Promise<void>((resolve) => globalThis.setTimeout(resolve, Math.min(pollIntervalMs, remainingMs)));
      }

      throw new Error('Timed out waiting for the transaction to be mined.');
    },
    [],
  );

  // Injected wallets have no revoke API, so this clears local session state only.
  const disconnect = useCallback(() => {
    invalidateOperations(null);
  }, [invalidateOperations]);

  return {
    available,
    address,
    chainId,
    onMonad: chainId === BigInt(MONAD.id),
    connecting,
    switching,
    error,
    connect,
    disconnect,
    switchToMonad,
    estimateTransactionFee,
    sendTransaction,
    waitForTransaction,
  };
}
