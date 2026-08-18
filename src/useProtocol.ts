import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CONTRACTS,
  SELECTOR,
  callWithAddress,
  callWithAddressAndUint,
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
  ser9Image: string | null;
  ser9Description: string | null;
  ser9Decimals: number;
  ser9TotalSupply: bigint | null;
  totalStaked: bigint | null;
  rewardPerTokenStored: bigint | null;
  rewardRatePerBlock: bigint | null;
  totalMonadStaked: bigint | null;
  monadRewardPerTokenStored: bigint | null;
  monadRewardRatePerBlock: bigint | null;
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
  name: string | null;
  handle: string | null;
  smartWallet: string | null;
  predictedWallet: string | null;
  entityType: bigint | null;
  verified: boolean | null;
  reputation: bigint | null;
  staked: bigint | null;
  stakingRewards: bigint | null;
  monadStaked: bigint | null;
  monadRewards: bigint | null;
  pendingNFTRewards: bigint | null;
  ser9UnstakeRequestCount: bigint | null;
  ser9LatestUnstakeRequestId: bigint | null;
  ser9LatestUnstakeRequest: UnstakeRequest | null;
  monadUnstakeRequestCount: bigint | null;
  monadLatestUnstakeRequestId: bigint | null;
  monadLatestUnstakeRequest: UnstakeRequest | null;
  /** Legacy alias retained for consumers of the first live-read build. */
  pendingRewards: bigint | null;
};

export type UnstakeRequest = {
  amount: bigint;
  requestEpoch: bigint;
  minClaimEpoch: bigint;
  claimed: boolean;
};

const EMPTY_ACCOUNT: AccountStats = {
  loading: false,
  monBalance: null,
  ser9Balance: null,
  tokenId: null,
  name: null,
  handle: null,
  smartWallet: null,
  predictedWallet: null,
  entityType: null,
  verified: null,
  reputation: null,
  staked: null,
  stakingRewards: null,
  monadStaked: null,
  monadRewards: null,
  pendingNFTRewards: null,
  ser9UnstakeRequestCount: null,
  ser9LatestUnstakeRequestId: null,
  ser9LatestUnstakeRequest: null,
  monadUnstakeRequestCount: null,
  monadLatestUnstakeRequestId: null,
  monadLatestUnstakeRequest: null,
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
    ser9Image: null,
    ser9Description: null,
    ser9Decimals: 18,
    ser9TotalSupply: null,
    totalStaked: null,
    rewardPerTokenStored: null,
    rewardRatePerBlock: null,
    totalMonadStaked: null,
    monadRewardPerTokenStored: null,
    monadRewardRatePerBlock: null,
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
            ethCall(CONTRACTS.ser9, SELECTOR.image),
            ethCall(CONTRACTS.ser9, SELECTOR.description),
            ethCall(CONTRACTS.ser9, SELECTOR.decimals),
            ethCall(CONTRACTS.ser9, SELECTOR.totalSupply),
            ethCall(CONTRACTS.staking, SELECTOR.totalStaked),
            ethCall(CONTRACTS.staking, SELECTOR.rewardPerTokenStored),
            ethCall(CONTRACTS.staking, SELECTOR.rewardRatePerBlock),
            ethCall(CONTRACTS.staking, SELECTOR.totalMonadStaked),
            ethCall(CONTRACTS.staking, SELECTOR.monadRewardPerTokenStored),
            ethCall(CONTRACTS.staking, SELECTOR.monadRewardRatePerBlock),
            ethCall(CONTRACTS.identity, SELECTOR.totalReputationScore),
            ethCall(CONTRACTS.identity, SELECTOR.humanMintFee),
            ethCall(CONTRACTS.identity, SELECTOR.aiMintFee),
          ],
          controller.signal,
        );

        const blockNumber = decodeUint(results[0]);
        const decimals = decodeUint(results[5]);
        const gasSeries = blockNumber ? await fetchGasSeries(blockNumber, controller.signal) : [];

        setStats((previous) => ({
          ...previous,
          loading: false,
          error: null,
          blockNumber,
          gasPriceWei: decodeUint(results[1]),
          ser9Symbol: decodeString(results[2]),
          ser9Image: decodeString(results[3]),
          ser9Description: decodeString(results[4]),
          ser9Decimals: decimals === null ? 18 : Number(decimals),
          ser9TotalSupply: decodeUint(results[6]),
          totalStaked: decodeUint(results[7]),
          rewardPerTokenStored: decodeUint(results[8]),
          rewardRatePerBlock: decodeUint(results[9]),
          totalMonadStaked: decodeUint(results[10]),
          monadRewardPerTokenStored: decodeUint(results[11]),
          monadRewardRatePerBlock: decodeUint(results[12]),
          totalReputationScore: decodeUint(results[13]),
          humanMintFee: decodeUint(results[14]),
          aiMintFee: decodeUint(results[15]),
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

function decodeUnstakeRequest(result: unknown): UnstakeRequest | null {
  if (typeof result !== 'string' || !/^0x[0-9a-fA-F]{256}$/.test(result)) return null;

  const word = (index: number) => decodeUint(`0x${result.slice(2 + index * 64, 2 + (index + 1) * 64)}`);
  const amount = word(0);
  const requestEpoch = word(1);
  const minClaimEpoch = word(2);
  const claimed = decodeBool(`0x${result.slice(2 + 3 * 64, 2 + 4 * 64)}`);

  if (amount === null || requestEpoch === null || minClaimEpoch === null || claimed === null) return null;
  return { amount, requestEpoch, minClaimEpoch, claimed };
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
        callWithAddress(CONTRACTS.staking, SELECTOR.earned, target),
        callWithAddress(CONTRACTS.staking, SELECTOR.monadEarned, target),
        callWithAddress(CONTRACTS.staking, SELECTOR.monadStakedBalance, target),
        callWithAddress(CONTRACTS.staking, SELECTOR.ser9UnstakeRequestCount, target),
        callWithAddress(CONTRACTS.staking, SELECTOR.monadUnstakeRequestCount, target),
      ],
      signal,
    );

    const tokenId = decodeUint(results[2]);
    const hasIdentity = tokenId !== null && tokenId > 0n;

    const identityResults = hasIdentity
      ? await rpcBatch(
          [
            callWithAddress(CONTRACTS.identity, SELECTOR.nameOf, target),
            callWithUint(CONTRACTS.identity, SELECTOR.handleOf, tokenId),
            callWithUint(CONTRACTS.identity, SELECTOR.walletOf, tokenId),
            callWithUint(CONTRACTS.identity, SELECTOR.predictWalletAddress, tokenId),
            callWithUint(CONTRACTS.identity, SELECTOR.getEntityType, tokenId),
            callWithUint(CONTRACTS.identity, SELECTOR.isVerified, tokenId),
          ],
          signal,
        ).catch(() => [null, null, null, null, null, null])
      : [null, null, null, null, null, null];

    const ser9UnstakeRequestCount = decodeUint(results[9]);
    const monadUnstakeRequestCount = decodeUint(results[10]);
    const requestResults = await rpcBatch(
      [
        ...(ser9UnstakeRequestCount !== null && ser9UnstakeRequestCount > 0n
          ? [callWithAddressAndUint(CONTRACTS.staking, SELECTOR.ser9UnstakeRequest, target, ser9UnstakeRequestCount - 1n)]
          : []),
        ...(monadUnstakeRequestCount !== null && monadUnstakeRequestCount > 0n
          ? [callWithAddressAndUint(CONTRACTS.staking, SELECTOR.monadUnstakeRequest, target, monadUnstakeRequestCount - 1n)]
          : []),
      ],
      signal,
    ).catch(() => []);

    let requestIndex = 0;
    const ser9LatestUnstakeRequest = ser9UnstakeRequestCount !== null && ser9UnstakeRequestCount > 0n
      ? decodeUnstakeRequest(requestResults[requestIndex++])
      : null;
    const monadLatestUnstakeRequest = monadUnstakeRequestCount !== null && monadUnstakeRequestCount > 0n
      ? decodeUnstakeRequest(requestResults[requestIndex])
      : null;

    const pendingNFTRewards = decodeUint(results[5]);

    return {
      loading: false,
      monBalance: decodeUint(results[0]),
      ser9Balance: decodeUint(results[1]),
      tokenId: hasIdentity ? tokenId : null,
      name: decodeString(identityResults[0]),
      handle: decodeString(identityResults[1]),
      smartWallet: decodeAddress(identityResults[2]),
      predictedWallet: decodeAddress(identityResults[3]),
      entityType: decodeUint(identityResults[4]),
      verified: decodeBool(identityResults[5]),
      reputation: decodeUint(results[3]),
      staked: decodeUint(results[4]),
      stakingRewards: decodeUint(results[6]),
      monadStaked: decodeUint(results[8]),
      monadRewards: decodeUint(results[7]),
      pendingNFTRewards,
      ser9UnstakeRequestCount,
      ser9LatestUnstakeRequestId:
        ser9UnstakeRequestCount !== null && ser9UnstakeRequestCount > 0n ? ser9UnstakeRequestCount - 1n : null,
      ser9LatestUnstakeRequest,
      monadUnstakeRequestCount,
      monadLatestUnstakeRequestId:
        monadUnstakeRequestCount !== null && monadUnstakeRequestCount > 0n ? monadUnstakeRequestCount - 1n : null,
      monadLatestUnstakeRequest,
      pendingRewards: pendingNFTRewards,
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
