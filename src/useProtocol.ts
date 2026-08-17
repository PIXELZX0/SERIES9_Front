import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CONTRACTS,
  SELECTOR,
  callWithAddress,
  callWithUint,
  decodeAddress,
  decodeBool,
  decodeString,
  decodeUint,
  ethCall,
  rpcBatch,
} from './chain.ts';

const POLL_INTERVAL_MS = 8_000;

/** Blocks between the samples that make up the throughput chart. */
const CHART_SAMPLE_COUNT = 12;
const CHART_SAMPLE_STRIDE = 50;

export type ProtocolStats = {
  loading: boolean;
  error: string | null;
  blockNumber: bigint | null;
  gasPriceWei: bigint | null;
  ser9Symbol: string | null;
  ser9Decimals: number;
  ser9TotalSupply: bigint | null;
  totalStaked: bigint | null;
  rewardPerTokenStored: bigint | null;
  totalReputationScore: bigint | null;
  humanMintFee: bigint | null;
  aiMintFee: bigint | null;
  identityCount: number | null;
  walletCount: number | null;
  /** Gas used per sampled block, oldest first. */
  gasSeries: number[];
};

export type AccountStats = {
  loading: boolean;
  monBalance: bigint | null;
  ser9Balance: bigint | null;
  tokenId: bigint | null;
  handle: string | null;
  smartWallet: string | null;
  verified: boolean | null;
  reputation: bigint | null;
  staked: bigint | null;
  pendingRewards: bigint | null;
};

const EMPTY_ACCOUNT: AccountStats = {
  loading: false,
  monBalance: null,
  ser9Balance: null,
  tokenId: null,
  handle: null,
  smartWallet: null,
  verified: null,
  reputation: null,
  staked: null,
  pendingRewards: null,
};

/**
 * Identity is a plain ERC-721 (no Enumerable, `_nextTokenId` is private), so
 * supply is found by probing `ownerOf`: one batched exponential ladder to
 * bracket the range, then a bisect. O(log n) round trips, and unlike
 * `eth_getLogs` it is not capped to a 100-block window on the public RPC.
 */
export async function fetchIdentityCount(signal: AbortSignal): Promise<number | null> {
  const ladder: number[] = [];
  for (let probe = 1; probe <= 65_536; probe *= 2) ladder.push(probe);

  const ladderResults = await rpcBatch(
    ladder.map((tokenId) => callWithUint(CONTRACTS.identity, SELECTOR.ownerOf, BigInt(tokenId))),
    signal,
  );

  // `ownerOf` reverts for unminted ids, so a null marks the first gap.
  const firstMissing = ladderResults.findIndex((result) => result === null);
  if (firstMissing === 0) return 0;
  if (firstMissing === -1) return ladder[ladder.length - 1];

  let low = ladder[firstMissing - 1];
  let high = ladder[firstMissing];

  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    const [result] = await rpcBatch(
      [callWithUint(CONTRACTS.identity, SELECTOR.ownerOf, BigInt(middle))],
      signal,
    );
    if (result === null) high = middle;
    else low = middle;
  }

  return low;
}

async function fetchWalletCount(identityCount: number, signal: AbortSignal): Promise<number | null> {
  if (identityCount <= 0) return 0;

  // Bounded so a large supply can never fan out into an unbounded batch.
  const scanLimit = Math.min(identityCount, 200);
  const results = await rpcBatch(
    Array.from({ length: scanLimit }, (_, index) =>
      callWithUint(CONTRACTS.identity, SELECTOR.walletOf, BigInt(index + 1)),
    ),
    signal,
  );

  return results.filter((result) => decodeAddress(result) !== null).length;
}

export async function fetchGasSeries(head: bigint, signal: AbortSignal): Promise<number[]> {
  const blocks = Array.from({ length: CHART_SAMPLE_COUNT }, (_, index) => {
    const offset = BigInt((CHART_SAMPLE_COUNT - 1 - index) * CHART_SAMPLE_STRIDE);
    return head > offset ? head - offset : 0n;
  });

  const results = await rpcBatch(
    blocks.map((blockNumber) => ({
      method: 'eth_getBlockByNumber',
      params: [`0x${blockNumber.toString(16)}`, false],
    })),
    signal,
  );

  return results.map((result) => {
    const block = result as unknown as { gasUsed?: string } | null;
    return block?.gasUsed ? Number(BigInt(block.gasUsed)) : 0;
  });
}

export function useProtocol(): ProtocolStats {
  const [stats, setStats] = useState<ProtocolStats>({
    loading: true,
    error: null,
    blockNumber: null,
    gasPriceWei: null,
    ser9Symbol: null,
    ser9Decimals: 18,
    ser9TotalSupply: null,
    totalStaked: null,
    rewardPerTokenStored: null,
    totalReputationScore: null,
    humanMintFee: null,
    aiMintFee: null,
    identityCount: null,
    walletCount: null,
    gasSeries: [],
  });

  // Supply rarely moves; probe it once per mount rather than every poll.
  const supplyProbed = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    let timeoutId = 0;

    async function refresh() {
      try {
        const results = await rpcBatch(
          [
            { method: 'eth_blockNumber', params: [] },
            { method: 'eth_gasPrice', params: [] },
            ethCall(CONTRACTS.ser9, SELECTOR.symbol),
            ethCall(CONTRACTS.ser9, SELECTOR.decimals),
            ethCall(CONTRACTS.ser9, SELECTOR.totalSupply),
            ethCall(CONTRACTS.staking, SELECTOR.totalStaked),
            ethCall(CONTRACTS.staking, SELECTOR.rewardPerTokenStored),
            ethCall(CONTRACTS.identity, SELECTOR.totalReputationScore),
            ethCall(CONTRACTS.identity, SELECTOR.humanMintFee),
            ethCall(CONTRACTS.identity, SELECTOR.aiMintFee),
          ],
          controller.signal,
        );

        const blockNumber = decodeUint(results[0]);
        const decimals = decodeUint(results[3]);
        const gasSeries = blockNumber ? await fetchGasSeries(blockNumber, controller.signal) : [];

        setStats((previous) => ({
          ...previous,
          loading: false,
          error: null,
          blockNumber,
          gasPriceWei: decodeUint(results[1]),
          ser9Symbol: decodeString(results[2]),
          ser9Decimals: decimals === null ? 18 : Number(decimals),
          ser9TotalSupply: decodeUint(results[4]),
          totalStaked: decodeUint(results[5]),
          rewardPerTokenStored: decodeUint(results[6]),
          totalReputationScore: decodeUint(results[7]),
          humanMintFee: decodeUint(results[8]),
          aiMintFee: decodeUint(results[9]),
          gasSeries,
        }));

        if (!supplyProbed.current) {
          supplyProbed.current = true;
          const identityCount = await fetchIdentityCount(controller.signal);
          const walletCount =
            identityCount === null ? null : await fetchWalletCount(identityCount, controller.signal);
          setStats((previous) => ({ ...previous, identityCount, walletCount }));
        }
      } catch (refreshError) {
        if (controller.signal.aborted) return;
        setStats((previous) => ({
          ...previous,
          loading: false,
          error: refreshError instanceof Error ? refreshError.message : 'Monad RPC unreachable',
        }));
      } finally {
        if (!controller.signal.aborted) {
          timeoutId = window.setTimeout(refresh, POLL_INTERVAL_MS);
        }
      }
    }

    void refresh();

    return () => {
      controller.abort();
      window.clearTimeout(timeoutId);
    };
  }, []);

  return stats;
}

export function useAccount(address: string | null, blockNumber: bigint | null): AccountStats {
  const [snapshot, setSnapshot] = useState<{ address: string; data: AccountStats } | null>(null);

  // Re-read roughly once per poll tick rather than on every new block.
  const tick = blockNumber === null ? 0 : Number(blockNumber / 100n);

  const load = useCallback(async (target: string, signal: AbortSignal): Promise<AccountStats> => {
    const results = await rpcBatch(
      [
        { method: 'eth_getBalance', params: [target, 'latest'] },
        callWithAddress(CONTRACTS.ser9, SELECTOR.balanceOf, target),
        callWithAddress(CONTRACTS.identity, SELECTOR.ownerTokenId, target),
        callWithAddress(CONTRACTS.identity, SELECTOR.reputationScoreOf, target),
        callWithAddress(CONTRACTS.staking, SELECTOR.stakedBalance, target),
        callWithAddress(CONTRACTS.identity, SELECTOR.pendingNFTRewards, target),
      ],
      signal,
    );

    const tokenId = decodeUint(results[2]);
    const hasIdentity = tokenId !== null && tokenId > 0n;

    const identityResults = hasIdentity
      ? await rpcBatch(
          [
            callWithUint(CONTRACTS.identity, SELECTOR.handleOf, tokenId),
            callWithUint(CONTRACTS.identity, SELECTOR.walletOf, tokenId),
            callWithUint(CONTRACTS.identity, SELECTOR.isVerified, tokenId),
          ],
          signal,
        )
      : [null, null, null];

    return {
      loading: false,
      monBalance: decodeUint(results[0]),
      ser9Balance: decodeUint(results[1]),
      tokenId: hasIdentity ? tokenId : null,
      handle: decodeString(identityResults[0]),
      smartWallet: decodeAddress(identityResults[1]),
      verified: decodeBool(identityResults[2]),
      reputation: decodeUint(results[3]),
      staked: decodeUint(results[4]),
      pendingRewards: decodeUint(results[5]),
    };
  }, []);

  useEffect(() => {
    if (!address) return;

    const controller = new AbortController();

    void load(address, controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setSnapshot({ address, data });
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setSnapshot({ address, data: EMPTY_ACCOUNT });
      });

    return () => controller.abort();
  }, [address, tick, load]);

  if (!address) return EMPTY_ACCOUNT;
  if (snapshot?.address !== address) return { ...EMPTY_ACCOUNT, loading: true };
  return snapshot.data;
}
