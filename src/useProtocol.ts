import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  CONTRACTS,
  SELECTOR,
  callWithAddress,
  callWithAddressAndUint,
  callWithUint,
  decodeAddress,
  decodeAddressRead,
  decodeBool,
  decodeProfiles,
  decodeString,
  decodeUint,
  ethCall,
  encodeModerators,
  encodeOwner,
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
  pendingStakingRewards: bigint | null;
  identityCount: number | null;
  walletCount: number | null;
  /** Gas used per sampled block, oldest first. */
  gasSeries: number[];
};

export type AccountStats = {
  loading: boolean;
  readStatus: 'idle' | 'loading' | 'ready' | 'error';
  readError: string | null;
  profileReadReady: boolean;
  walletOfReadReady: boolean;
  predictedWalletReadReady: boolean;
  monBalance: bigint | null;
  ser9Balance: bigint | null;
  identityOwner: boolean | null;
  identityModerator: boolean | null;
  tokenId: bigint | null;
  identityImage: string | null;
  name: string | null;
  bio: string | null;
  handle: string | null;
  smartWallet: string | null;
  predictedWallet: string | null;
  entityType: bigint | null;
  hue: bigint | null;
  saturation: bigint | null;
  verified: boolean | null;
  registeredAt: bigint | null;
  reputation: bigint | null;
  staked: bigint | null;
  stakingRewards: bigint | null;
  monadStaked: bigint | null;
  monadRewards: bigint | null;
  pendingNFTRewards: bigint | null;
  ser9UnstakeRequestCount: bigint | null;
  ser9LatestUnstakeRequestId: bigint | null;
  ser9LatestUnstakeRequest: UnstakeRequest | null;
  ser9LatestUnstakeRequestReady: boolean;
  monadUnstakeRequestCount: bigint | null;
  monadLatestUnstakeRequestId: bigint | null;
  monadLatestUnstakeRequest: UnstakeRequest | null;
  monadLatestUnstakeRequestReady: boolean;
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
  readStatus: 'idle',
  readError: null,
  profileReadReady: false,
  walletOfReadReady: false,
  predictedWalletReadReady: false,
  monBalance: null,
  ser9Balance: null,
  identityOwner: null,
  identityModerator: null,
  tokenId: null,
  identityImage: null,
  name: null,
  bio: null,
  handle: null,
  smartWallet: null,
  predictedWallet: null,
  entityType: null,
  hue: null,
  saturation: null,
  verified: null,
  registeredAt: null,
  reputation: null,
  staked: null,
  stakingRewards: null,
  monadStaked: null,
  monadRewards: null,
  pendingNFTRewards: null,
  ser9UnstakeRequestCount: null,
  ser9LatestUnstakeRequestId: null,
  ser9LatestUnstakeRequest: null,
  ser9LatestUnstakeRequestReady: false,
  monadUnstakeRequestCount: null,
  monadLatestUnstakeRequestId: null,
  monadLatestUnstakeRequest: null,
  monadLatestUnstakeRequestReady: false,
  pendingRewards: null,
};

type AccountSessionSnapshot = { address: string | null; id: number };

type AccountSessionStore = {
  getSnapshot: () => AccountSessionSnapshot;
  subscribe: (listener: () => void) => () => void;
  setAddress: (address: string | null) => void;
};

function createAccountSessionStore(address: string | null): AccountSessionStore {
  let snapshot: AccountSessionSnapshot = { address, id: 0 };
  const listeners = new Set<() => void>();

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setAddress: (nextAddress) => {
      if (snapshot.address === nextAddress) return;
      snapshot = { address: nextAddress, id: snapshot.id + 1 };
      listeners.forEach((listener) => listener());
    },
  };
}

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

function decodeIdentityMetadataUri(tokenUri: string): string | null {
  const commaIndex = tokenUri.indexOf(',');
  if (commaIndex < 0) return null;

  const metadata = tokenUri.slice(0, commaIndex);
  if (!/^data:application\/json(?:;[^,]*)?$/i.test(metadata)) return null;

  const payload = tokenUri.slice(commaIndex + 1);
  if (/(?:^|;)base64(?:;|$)/i.test(metadata)) {
    try {
      const binary = atob(payload.replace(/\s/g, ''));
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      return new TextDecoder().decode(bytes);
    } catch {
      return null;
    }
  }

  try {
    return decodeURIComponent(payload);
  } catch {
    return payload;
  }
}

function extractIdentityImage(tokenUri: string | null): string | null {
  if (!tokenUri) return null;

  try {
    const metadataText = decodeIdentityMetadataUri(tokenUri);
    if (!metadataText) return null;

    const metadata: unknown = JSON.parse(metadataText);
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;

    const values = metadata as Record<string, unknown>;
    for (const key of ['image', 'image_url']) {
      const image = values[key];
      if (typeof image === 'string' && image.trim()) return image.trim();
    }
  } catch {
    // A broken tokenURI must not make the account read unusable.
  }

  return null;
}

export function useProtocol(refreshVersion = 0): ProtocolStats {
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
    pendingStakingRewards: null,
    identityCount: null,
    walletCount: null,
    gasSeries: [],
  });

  // Supply rarely moves; probe it once per mount rather than every poll.
  const supplyProbed = useRef(false);
  const completedRefreshVersion = useRef<number | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let timeoutId = 0;

    // Keep writes disabled before a forced refresh begins its RPC read.
    setStats((previous) => ({ ...previous, loading: true }));

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
            ethCall(CONTRACTS.identity, SELECTOR.pendingStakingRewards),
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
          pendingStakingRewards: decodeUint(results[16]),
          gasSeries,
        }));
        completedRefreshVersion.current = refreshVersion;

        if (!supplyProbed.current) {
          supplyProbed.current = true;
          const identityCount = await fetchIdentityCount(controller.signal);
          const walletCount =
            identityCount === null ? null : await fetchWalletCount(identityCount, controller.signal);
          setStats((previous) => ({ ...previous, identityCount, walletCount }));
        }
      } catch (refreshError) {
        if (controller.signal.aborted) return;
        completedRefreshVersion.current = refreshVersion;
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
  }, [refreshVersion]);

  return completedRefreshVersion.current === refreshVersion ? stats : { ...stats, loading: true };
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

export function useAccount(address: string | null, blockNumber: bigint | null, refreshVersion: number): AccountStats {
  const [snapshot, setSnapshot] = useState<{
    address: string;
    session: number;
    tick: number;
    refreshVersion: number;
    data: AccountStats;
  } | null>(null);
  const [accountSessionStore] = useState(() => createAccountSessionStore(address));
  const accountSession = useSyncExternalStore(
    accountSessionStore.subscribe,
    accountSessionStore.getSnapshot,
    accountSessionStore.getSnapshot,
  );

  useEffect(() => {
    accountSessionStore.setAddress(address);
  }, [accountSessionStore, address]);

  // Re-read roughly once per poll tick rather than on every new block.
  const tick = blockNumber === null ? 0 : Number(blockNumber / 100n);

  const load = useCallback(async (target: string, signal: AbortSignal): Promise<AccountStats> => {
    const [results, permissionResults] = await Promise.all([
      rpcBatch(
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
      ),
      rpcBatch(
        [
          ethCall(CONTRACTS.identity, encodeOwner()),
          ethCall(CONTRACTS.identity, encodeModerators(target)),
        ],
        signal,
      ).catch(() => [null, null]),
    ]);

    const accountReads = results.slice(0, 11).map((result) => decodeUint(result));
    if (accountReads.some((value) => value === null)) throw new Error('Account read incomplete.');

    const tokenId = accountReads[2];
    if (tokenId === null) throw new Error('Identity ownership read unavailable.');
    const hasIdentity = tokenId !== null && tokenId > 0n;
    const ownerAddress = decodeAddress(permissionResults[0]);
    const identityOwner = ownerAddress === null ? null : ownerAddress.toLowerCase() === target.toLowerCase();
    const moderator = decodeBool(permissionResults[1]);
    const identityModerator = identityOwner === true || moderator === true
      ? true
      : identityOwner === false && moderator === false
        ? false
        : null;

    const identityResults = hasIdentity
      ? await rpcBatch(
          [
            callWithAddress(CONTRACTS.identity, SELECTOR.nameOf, target),
            callWithUint(CONTRACTS.identity, SELECTOR.handleOf, tokenId),
            callWithUint(CONTRACTS.identity, SELECTOR.walletOf, tokenId),
            callWithUint(CONTRACTS.identity, SELECTOR.predictWalletAddress, tokenId),
            callWithUint(CONTRACTS.identity, SELECTOR.getEntityType, tokenId),
            callWithUint(CONTRACTS.identity, SELECTOR.isVerified, tokenId),
            callWithUint(CONTRACTS.identity, SELECTOR.tokenURI, tokenId),
            callWithUint(CONTRACTS.identity, SELECTOR.profiles, tokenId),
          ],
          signal,
        )
      : [null, null, null, null, null, null, null, null];

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
    const ser9LatestUnstakeRequestReady = ser9UnstakeRequestCount === 0n || ser9LatestUnstakeRequest !== null;
    const monadLatestUnstakeRequestReady = monadUnstakeRequestCount === 0n || monadLatestUnstakeRequest !== null;

    const pendingNFTRewards = decodeUint(results[5]);
    const identityImage = extractIdentityImage(decodeString(identityResults[6]));
    const profile = decodeProfiles(identityResults[7]);
    const handle = decodeString(identityResults[1]);
    const walletOfRead = hasIdentity ? decodeAddressRead(identityResults[2]) : null;
    const predictedWalletRead = hasIdentity ? decodeAddressRead(identityResults[3]) : null;

    if (hasIdentity && profile === null) throw new Error('Identity profile read unavailable.');
    if (hasIdentity && handle === null) throw new Error('Identity handle read unavailable.');
    if (hasIdentity && (!walletOfRead?.ready || !predictedWalletRead?.ready)) {
      throw new Error('Smart wallet address reads unavailable.');
    }

    return {
      loading: false,
      readStatus: 'ready',
      readError: null,
      profileReadReady: hasIdentity && profile !== null,
      walletOfReadReady: walletOfRead?.ready ?? false,
      predictedWalletReadReady: predictedWalletRead?.ready ?? false,
      monBalance: decodeUint(results[0]),
      ser9Balance: decodeUint(results[1]),
      identityOwner,
      identityModerator,
      tokenId: hasIdentity ? tokenId : null,
      identityImage: hasIdentity ? identityImage : null,
      name: profile?.name ?? null,
      bio: profile?.bio ?? null,
      handle: hasIdentity ? handle : null,
      smartWallet: walletOfRead?.address ?? null,
      predictedWallet: predictedWalletRead?.address ?? null,
      entityType: profile?.entityType ?? decodeUint(identityResults[4]),
      hue: profile?.hue ?? null,
      saturation: profile?.saturation ?? null,
      verified: profile?.verified ?? decodeBool(identityResults[5]),
      registeredAt: profile?.registeredAt ?? null,
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
      ser9LatestUnstakeRequestReady,
      monadUnstakeRequestCount,
      monadLatestUnstakeRequestId:
        monadUnstakeRequestCount !== null && monadUnstakeRequestCount > 0n ? monadUnstakeRequestCount - 1n : null,
      monadLatestUnstakeRequest,
      monadLatestUnstakeRequestReady,
      pendingRewards: pendingNFTRewards,
    };
  }, []);

  useEffect(() => {
    if (!address) return;

    const controller = new AbortController();
    const requestSession = accountSession.id;
    const requestTick = tick;
    const requestRefreshVersion = refreshVersion;

    void load(address, controller.signal)
      .then((data) => {
        if (controller.signal.aborted || accountSessionStore.getSnapshot().id !== requestSession) return;
        setSnapshot({ address, session: requestSession, tick: requestTick, refreshVersion: requestRefreshVersion, data });
      })
      .catch((readError) => {
        if (controller.signal.aborted || accountSessionStore.getSnapshot().id !== requestSession) return;
        const message = readError instanceof Error ? readError.message : 'Monad account read unavailable.';
        setSnapshot((previous) => {
          const previousData = previous?.address === address && previous.session === requestSession
            ? previous.data
            : EMPTY_ACCOUNT;
          return {
            address,
            session: requestSession,
            tick: requestTick,
            refreshVersion: requestRefreshVersion,
            data: {
              ...previousData,
              loading: false,
              readStatus: 'error',
              readError: message,
            },
          };
        });
      });

    return () => controller.abort();
  }, [accountSession.id, accountSessionStore, address, load, refreshVersion, tick]);

  if (!address) return EMPTY_ACCOUNT;
  if (
    accountSession.address !== address ||
    snapshot?.address !== address ||
    snapshot.session !== accountSession.id ||
    snapshot.refreshVersion !== refreshVersion
  ) {
    return { ...EMPTY_ACCOUNT, loading: true, readStatus: 'loading' };
  }
  if (snapshot.tick !== tick) {
    return {
      ...snapshot.data,
      loading: true,
      readStatus: 'loading',
      readError: null,
      identityOwner: null,
      identityModerator: null,
    };
  }
  return snapshot.data;
}
