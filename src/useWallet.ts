import { useCallback, useEffect, useState } from 'react';
import { MONAD } from './chain.ts';

/** EIP-1193 provider surface, narrowed to what this site calls. */
type Eip1193Provider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, handler: (...args: never[]) => void) => void;
  removeListener?: (event: string, handler: (...args: never[]) => void) => void;
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

export type WalletState = {
  available: boolean;
  address: string | null;
  chainId: number | null;
  onMonad: boolean;
  connecting: boolean;
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

function readRejectionMessage(error: unknown): string {
  // EIP-1193 user rejection.
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === 4001) {
    return 'Connection request rejected.';
  }
  if (error instanceof Error) return error.message;
  return 'Wallet request failed.';
}

function readTransactionError(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === 4001) {
    return 'Transaction request rejected by your wallet.';
  }
  if (error instanceof Error) return error.message;
  return 'Transaction request failed.';
}

function encodeQuantity(value: bigint | string): string {
  if (typeof value === 'string' && /^0x[0-9a-fA-F]+$/.test(value)) return value.toLowerCase();

  let numeric: bigint;
  try {
    numeric = typeof value === 'bigint' ? value : BigInt(value);
  } catch {
    throw new Error('Transaction value must be a non-negative integer.');
  }

  if (numeric < 0n) throw new Error('Transaction value must be a non-negative integer.');
  return `0x${numeric.toString(16)}`;
}

function decodeRpcQuantity(value: unknown, label: string): bigint {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`${label} returned an invalid quantity.`);
  }

  try {
    return BigInt(value);
  } catch {
    throw new Error(`${label} returned an invalid quantity.`);
  }
}

/**
 * Wallet connection over the injected EIP-1193 provider.
 *
 * ponytail: single-provider (`window.ethereum`) discovery only — add EIP-6963
 * multi-wallet enumeration if users report the wrong extension being picked.
 */
export function useWallet(): WalletState {
  const [address, setAddress] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const available = typeof window !== 'undefined' && Boolean(window.ethereum);

  // Restore an already-authorized session and track wallet-side changes.
  useEffect(() => {
    const provider = getProvider();
    if (!provider) return;

    let active = true;

    void (async () => {
      try {
        const accounts = (await provider.request({ method: 'eth_accounts' })) as string[];
        const currentChain = (await provider.request({ method: 'eth_chainId' })) as string;
        if (!active) return;

        setAddress(accounts[0] ?? null);
        setChainId(Number(currentChain));
      } catch {
        // A locked or unavailable wallet is not an error worth surfacing on load.
      }
    })();

    const handleAccountsChanged = (...args: never[]) => {
      const accounts = args[0] as unknown as string[];
      setAddress(accounts[0] ?? null);
    };
    const handleChainChanged = (...args: never[]) => {
      setChainId(Number(args[0] as unknown as string));
    };

    provider.on?.('accountsChanged', handleAccountsChanged);
    provider.on?.('chainChanged', handleChainChanged);

    return () => {
      active = false;
      provider.removeListener?.('accountsChanged', handleAccountsChanged);
      provider.removeListener?.('chainChanged', handleChainChanged);
    };
  }, []);

  const switchToMonad = useCallback(async () => {
    const provider = getProvider();
    if (!provider) return;

    try {
      await provider.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: MONAD.idHex }],
      });
    } catch (switchError) {
      // 4902: chain unknown to the wallet — add it, then explicitly switch.
      const code = (switchError as { code?: number }).code;
      if (code !== 4902 && code !== -32603) throw switchError;

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

      await provider.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: MONAD.idHex }],
      });
    }

    const currentChain = (await provider.request({ method: 'eth_chainId' })) as string;
    setChainId(Number(currentChain));
  }, []);

  const connect = useCallback(async (): Promise<ConnectResult> => {
    const provider = getProvider();
    if (!provider) {
      const message = 'No wallet detected. Install MetaMask or another Monad-compatible wallet.';
      setError(message);
      return { address: null, error: message };
    }

    setConnecting(true);
    setError(null);

    try {
      const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as string[];
      const connectedAddress = accounts[0] ?? null;
      setAddress(connectedAddress);

      const currentChain = (await provider.request({ method: 'eth_chainId' })) as string;
      if (Number(currentChain) !== MONAD.id) {
        await switchToMonad();
      } else {
        setChainId(Number(currentChain));
      }

      return { address: connectedAddress, error: null };
    } catch (connectError) {
      const message = readRejectionMessage(connectError);
      setError(message);
      return { address: null, error: message };
    } finally {
      setConnecting(false);
    }
  }, [switchToMonad]);

  const sendTransaction = useCallback(async (request: SendTransactionRequest): Promise<string> => {
    const provider = getProvider();
    if (!provider) throw new Error('No wallet detected. Install a Monad-compatible wallet first.');
    if (!address) throw new Error('Connect a wallet before sending a transaction.');
    if (!/^0x[0-9a-fA-F]{40}$/.test(request.to)) throw new Error('Transaction target is not a valid address.');

    const transaction: Record<string, string> = {
      from: address,
      to: request.to,
    };
    if (request.data !== undefined) transaction.data = request.data;
    if (request.value !== undefined) transaction.value = encodeQuantity(request.value);

    try {
      const hash = await provider.request({ method: 'eth_sendTransaction', params: [transaction] });
      if (typeof hash !== 'string' || !hash.startsWith('0x')) throw new Error('Wallet returned an invalid transaction hash.');
      return hash;
    } catch (sendError) {
      throw new Error(readTransactionError(sendError));
    }
  }, [address]);

  const estimateTransactionFee = useCallback(async (request: SendTransactionRequest): Promise<bigint> => {
    const provider = getProvider();
    if (!provider) throw new Error('No wallet detected. Install a Monad-compatible wallet first.');
    if (!address) throw new Error('Connect a wallet before estimating transaction fees.');
    if (!/^0x[0-9a-fA-F]{40}$/.test(request.to)) throw new Error('Transaction target is not a valid address.');

    const transaction: Record<string, string> = {
      from: address,
      to: request.to,
    };
    if (request.data !== undefined) transaction.data = request.data;
    if (request.value !== undefined) transaction.value = encodeQuantity(request.value);

    try {
      const [gasResult, gasPriceResult] = await Promise.all([
        provider.request({ method: 'eth_estimateGas', params: [transaction] }),
        provider.request({ method: 'eth_gasPrice', params: [] }),
      ]);
      const gas = decodeRpcQuantity(gasResult, 'eth_estimateGas');
      const gasPrice = decodeRpcQuantity(gasPriceResult, 'eth_gasPrice');
      return gas * gasPrice;
    } catch (estimateError) {
      if (estimateError instanceof Error && /returned an invalid quantity\.$/.test(estimateError.message)) {
        throw estimateError;
      }
      throw new Error(`Could not estimate transaction fee: ${readTransactionError(estimateError)}`);
    }
  }, [address]);

  const waitForTransaction = useCallback(
    async (hash: string, options: WaitForTransactionOptions = {}): Promise<TransactionReceipt> => {
      const provider = getProvider();
      if (!provider) throw new Error('No wallet detected while waiting for the transaction.');
      if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error('Invalid transaction hash.');

      const timeoutMs = options.timeoutMs ?? 120_000;
      const pollIntervalMs = options.pollIntervalMs ?? 1_500;
      const startedAt = Date.now();

      while (Date.now() - startedAt < timeoutMs) {
        let receipt: TransactionReceipt | null;
        try {
          receipt = (await provider.request({ method: 'eth_getTransactionReceipt', params: [hash] })) as TransactionReceipt | null;
        } catch (receiptError) {
          throw new Error(readTransactionError(receiptError));
        }

        if (receipt) {
          if (receipt.status === '0x0' || receipt.status === '0x00') {
            throw new Error('Transaction was mined but reverted on Monad.');
          }
          return receipt;
        }

        await new Promise<void>((resolve) => window.setTimeout(resolve, pollIntervalMs));
      }

      throw new Error('Timed out waiting for the transaction to be mined.');
    },
    [],
  );

  // Injected wallets have no revoke API, so this clears local session state only.
  const disconnect = useCallback(() => {
    setAddress(null);
    setError(null);
  }, []);

  return {
    available,
    address,
    chainId,
    onMonad: chainId === MONAD.id,
    connecting,
    error,
    connect,
    disconnect,
    switchToMonad,
    estimateTransactionFee,
    sendTransaction,
    waitForTransaction,
  };
}
