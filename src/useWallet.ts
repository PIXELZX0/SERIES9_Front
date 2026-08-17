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
      // 4902: chain unknown to the wallet — add it, then the wallet switches.
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
  };
}
