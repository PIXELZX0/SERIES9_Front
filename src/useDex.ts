import { useCallback, useEffect, useState } from 'react';
import {
  DEX_CONFIG,
  DEX_CONTRACTS,
  DEX_SELECTOR,
  decodeDexAddressRead,
  decodeDexBookConfig,
  decodeDexBool,
  decodeDexBytes32,
  decodeDexOrderbookLevel,
  decodeDexReserves,
  decodeDexString,
  decodeDexTokenSymbol,
  decodeDexUint,
  decodeDexUint32,
  dexCall,
  encodeDexNoArgs,
  encodeErc20Allowance,
  encodeErc20BalanceOf,
  encodeIsSpotPool,
  encodeOrderbookPairRead,
  encodePoolPairId,
  encodeSharesOf,
  normalizeDexAddress,
  readOrderWindow,
  type DecodedOrder,
  readSpotQuote as readDexSpotQuote,
  simulateSwapExactIn as simulateDexSwapExactIn,
} from './dex.ts';
import { decodeUint, rpcBatch } from './chain.ts';

export type DexRegistryStatus = 'healthy' | 'degraded' | 'unavailable';

/**
 * How far back to walk `Orderbook.orders`. Ids are global across every pair, so
 * this bounds one wallet's open-order lookup to a single RPC batch.
 */
const ORDER_SCAN_LIMIT = 150;

export type DexToken = {
  address: string;
  symbol: string | null;
  decimals: number | null;
};

export type DexPoolSnapshot = {
  address: string;
  invalidAddress: boolean;
  isSpotPool: boolean | null;
  registryPairId: string | null;
  poolRegistry: string | null;
  pairId: string | null;
  pairIdConsistent: boolean | null;
  poolOrderbook: string | null;
  poolTreasury: string | null;
  token0: DexToken | null;
  token1: DexToken | null;
  reserves: {
    reserve0: bigint;
    reserve1: bigint;
    blockTimestampLast: bigint | null;
  } | null;
  feePpm: bigint | null;
  spotPriceX18: bigint | null;
  reservePriceX18: bigint | null;
  totalShares: bigint | null;
  valid: boolean;
  hasLiquidity: boolean;
  error: string | null;
};

export type DexOrderbookLevel = {
  priceX18: bigint;
  totalBase: bigint;
};

export type DexBookConfig = {
  initialized: boolean;
  base: string | null;
  quote: string | null;
  tickSize: bigint;
};

export type DexOrderbookSnapshot = {
  pairId: string;
  bestBid: DexOrderbookLevel | null;
  bestAsk: DexOrderbookLevel | null;
  bookConfig: DexBookConfig | null;
};

export type DexRegistryWiring = {
  status: DexRegistryStatus;
  ready: boolean;
  registryAddress: string;
  treasury: string | null;
  orderbook: string | null;
  spotPoolFactory: string | null;
  perpPoolFactory: string | null;
  maxLpFeeRatePpm: bigint | null;
  infraRegistry: {
    orderbook: string | null;
    spotPoolFactory: string | null;
    perpPoolFactory: string | null;
    positionManager: string | null;
  };
  mismatches: string[];
};

export type DexPositionManagerSnapshot = {
  name: string | null;
  symbol: string | null;
  nextTokenId: bigint | null;
};

export type DexWalletToken = {
  address: string;
  balance: bigint | null;
  /** Spender is the SpotPool: swaps and deposits pull from here. */
  allowance: bigint | null;
  /** Spender is the shared Orderbook: limit orders escrow from here. */
  orderbookAllowance: bigint | null;
};

export type DexOpenOrder = {
  id: bigint;
  order: DecodedOrder;
};

export type DexWalletSnapshot = {
  address: string;
  token0: DexWalletToken | null;
  token1: DexWalletToken | null;
  shares: bigint | null;
  /** Native MON, so the UI can offer to wrap it into WMON on demand. */
  native: bigint | null;
};

export type DexState = {
  loading: boolean;
  error: string | null;
  registryWiring: DexRegistryWiring;
  pool: DexPoolSnapshot | null;
  orderbook: DexOrderbookSnapshot | null;
  positionManager: DexPositionManagerSnapshot;
  walletTokens: DexWalletSnapshot | null;
  nextOrderId: bigint | null;
  myOrders: DexOpenOrder[];
};

type ReadAddress = ReturnType<typeof decodeDexAddressRead>;

type ExtraIndexes = {
  symbol: number;
  decimals: number;
  balance: number | null;
  allowance: number | null;
};

function sameAddress(left: string | null, right: string): boolean {
  return left !== null && left.toLowerCase() === right.toLowerCase();
}

function createEmptyWiring(): DexRegistryWiring {
  return {
    status: 'unavailable',
    ready: false,
    registryAddress: DEX_CONTRACTS.registry,
    treasury: null,
    orderbook: null,
    spotPoolFactory: null,
    perpPoolFactory: null,
    maxLpFeeRatePpm: null,
    infraRegistry: {
      orderbook: null,
      spotPoolFactory: null,
      perpPoolFactory: null,
      positionManager: null,
    },
    mismatches: [],
  };
}

function createEmptyDexState(): DexState {
  return {
    loading: true,
    error: null,
    registryWiring: createEmptyWiring(),
    pool: null,
    orderbook: null,
    positionManager: { name: null, symbol: null, nextTokenId: null },
    walletTokens: null,
    nextOrderId: null,
    myOrders: [],
  };
}

function buildRegistryWiring(
  registryReads: {
    treasury: ReadAddress;
    orderbook: ReadAddress;
    spotPoolFactory: ReadAddress;
    perpPoolFactory: ReadAddress;
  },
  maxLpFeeRatePpm: bigint | null,
  infraReads: DexRegistryWiring['infraRegistry'] & {
    ready: {
      orderbook: boolean;
      spotPoolFactory: boolean;
      perpPoolFactory: boolean;
      positionManager: boolean;
    };
  },
): DexRegistryWiring {
  const values = {
    treasury: registryReads.treasury.address,
    orderbook: registryReads.orderbook.address,
    spotPoolFactory: registryReads.spotPoolFactory.address,
    perpPoolFactory: registryReads.perpPoolFactory.address,
  };
  const mismatches: string[] = [];
  const expected: Array<[keyof typeof values, string, string]> = [
    ['treasury', DEX_CONTRACTS.protocolTreasury, 'registry treasury'],
    ['orderbook', DEX_CONTRACTS.orderbook, 'registry orderbook'],
    ['spotPoolFactory', DEX_CONTRACTS.spotPoolFactory, 'registry spot factory'],
    ['perpPoolFactory', DEX_CONTRACTS.perpPoolFactory, 'registry perp factory'],
  ];

  expected.forEach(([key, address, label]) => {
    if (registryReads[key].ready && !sameAddress(values[key], address)) mismatches.push(label);
  });

  const infraExpected: Array<[keyof DexRegistryWiring['infraRegistry'], string]> = [
    ['orderbook', 'orderbook registry'],
    ['spotPoolFactory', 'spot factory registry'],
    ['perpPoolFactory', 'perp factory registry'],
    ['positionManager', 'position manager registry'],
  ];
  infraExpected.forEach(([key, label]) => {
    const value = infraReads[key];
    if (value !== null && !sameAddress(value, DEX_CONTRACTS.registry)) mismatches.push(label);
    if (value === null && infraReads.ready[key]) mismatches.push(label);
  });

  const registryReadsReady = Object.values(registryReads).every((read) => read.ready);
  const infraReadsReady = Object.values(infraReads.ready).every(Boolean);
  const ready = registryReadsReady && maxLpFeeRatePpm !== null && infraReadsReady;

  return {
    status: !ready ? 'unavailable' : mismatches.length > 0 ? 'degraded' : 'healthy',
    ready,
    registryAddress: DEX_CONTRACTS.registry,
    ...values,
    maxLpFeeRatePpm,
    infraRegistry: {
      orderbook: infraReads.orderbook,
      spotPoolFactory: infraReads.spotPoolFactory,
      perpPoolFactory: infraReads.perpPoolFactory,
      positionManager: infraReads.positionManager,
    },
    mismatches,
  };
}

function buildInvalidPool(address: string): DexPoolSnapshot {
  return {
    address,
    invalidAddress: true,
    isSpotPool: null,
    registryPairId: null,
    poolRegistry: null,
    pairId: null,
    pairIdConsistent: null,
    poolOrderbook: null,
    poolTreasury: null,
    token0: null,
    token1: null,
    reserves: null,
    feePpm: null,
    spotPriceX18: null,
    reservePriceX18: null,
    totalShares: null,
    valid: false,
    hasLiquidity: false,
    error: 'Enter a valid 20-byte SpotPool address.',
  };
}

async function readDexState(
  selectedPoolAddress: string | null | undefined,
  walletAddress: string | null,
  signal: AbortSignal,
): Promise<DexState> {
  const infraResults = await rpcBatch([
    dexCall(DEX_CONTRACTS.registry, encodeDexNoArgs(DEX_SELECTOR.treasury)),
    dexCall(DEX_CONTRACTS.registry, encodeDexNoArgs(DEX_SELECTOR.orderbook)),
    dexCall(DEX_CONTRACTS.registry, encodeDexNoArgs(DEX_SELECTOR.spotPoolFactory)),
    dexCall(DEX_CONTRACTS.registry, encodeDexNoArgs(DEX_SELECTOR.perpPoolFactory)),
    dexCall(DEX_CONTRACTS.registry, encodeDexNoArgs(DEX_SELECTOR.maxLpFeeRatePpm)),
    dexCall(DEX_CONTRACTS.orderbook, encodeDexNoArgs(DEX_SELECTOR.registry)),
    dexCall(DEX_CONTRACTS.spotPoolFactory, encodeDexNoArgs(DEX_SELECTOR.registry)),
    dexCall(DEX_CONTRACTS.perpPoolFactory, encodeDexNoArgs(DEX_SELECTOR.registry)),
    dexCall(DEX_CONTRACTS.positionManager, encodeDexNoArgs(DEX_SELECTOR.registry)),
    dexCall(DEX_CONTRACTS.positionManager, encodeDexNoArgs(DEX_SELECTOR.positionManagerName)),
    dexCall(DEX_CONTRACTS.positionManager, encodeDexNoArgs(DEX_SELECTOR.positionManagerSymbol)),
    dexCall(DEX_CONTRACTS.positionManager, encodeDexNoArgs(DEX_SELECTOR.nextTokenId)),
    dexCall(DEX_CONTRACTS.orderbook, encodeDexNoArgs(DEX_SELECTOR.nextOrderId)),
  ], signal);

  const registryReads = {
    treasury: decodeDexAddressRead(infraResults[0]),
    orderbook: decodeDexAddressRead(infraResults[1]),
    spotPoolFactory: decodeDexAddressRead(infraResults[2]),
    perpPoolFactory: decodeDexAddressRead(infraResults[3]),
  };
  const maxLpFeeRatePpm = decodeDexUint32(infraResults[4]);
  const infraRegistry = {
    orderbook: decodeDexAddressRead(infraResults[5]),
    spotPoolFactory: decodeDexAddressRead(infraResults[6]),
    perpPoolFactory: decodeDexAddressRead(infraResults[7]),
    positionManager: decodeDexAddressRead(infraResults[8]),
  };
  const registryWiring = buildRegistryWiring(
    registryReads,
    maxLpFeeRatePpm,
    {
      orderbook: infraRegistry.orderbook.address,
      spotPoolFactory: infraRegistry.spotPoolFactory.address,
      perpPoolFactory: infraRegistry.perpPoolFactory.address,
      positionManager: infraRegistry.positionManager.address,
      ready: {
        orderbook: infraRegistry.orderbook.ready,
        spotPoolFactory: infraRegistry.spotPoolFactory.ready,
        perpPoolFactory: infraRegistry.perpPoolFactory.ready,
        positionManager: infraRegistry.positionManager.ready,
      },
    },
  );
  const positionManager: DexPositionManagerSnapshot = {
    name: decodeDexString(infraResults[9]),
    symbol: decodeDexString(infraResults[10]),
    nextTokenId: decodeDexUint(infraResults[11]),
  };
  const nextOrderId = decodeDexUint(infraResults[12]);

  const rawPoolAddress = selectedPoolAddress?.trim() ?? '';
  const poolAddress = normalizeDexAddress(selectedPoolAddress);
  if (!poolAddress) {
    return {
      loading: false,
      error: null,
      registryWiring,
      pool: rawPoolAddress ? buildInvalidPool(rawPoolAddress) : null,
      orderbook: null,
      positionManager,
      walletTokens: null,
      nextOrderId,
      myOrders: [],
    };
  }

  const poolResults = await rpcBatch([
    dexCall(DEX_CONTRACTS.registry, encodeIsSpotPool(poolAddress)),
    dexCall(DEX_CONTRACTS.registry, encodePoolPairId(poolAddress)),
    dexCall(poolAddress, encodeDexNoArgs(DEX_SELECTOR.token0)),
    dexCall(poolAddress, encodeDexNoArgs(DEX_SELECTOR.token1)),
    dexCall(poolAddress, encodeDexNoArgs(DEX_SELECTOR.lpFeeRatePpm)),
    dexCall(poolAddress, encodeDexNoArgs(DEX_SELECTOR.pairId)),
    dexCall(poolAddress, encodeDexNoArgs(DEX_SELECTOR.getReserves)),
    dexCall(poolAddress, encodeDexNoArgs(DEX_SELECTOR.spotPriceX18)),
    dexCall(poolAddress, encodeDexNoArgs(DEX_SELECTOR.registry)),
    dexCall(poolAddress, encodeDexNoArgs(DEX_SELECTOR.orderbook)),
    dexCall(poolAddress, encodeDexNoArgs(DEX_SELECTOR.treasury)),
    dexCall(poolAddress, encodeDexNoArgs(DEX_SELECTOR.totalShares)),
  ], signal);

  const isSpotPool = decodeDexBool(poolResults[0]);
  const registryPairId = decodeDexBytes32(poolResults[1]);
  const token0Read = decodeDexAddressRead(poolResults[2]);
  const token1Read = decodeDexAddressRead(poolResults[3]);
  const feePpm = decodeDexUint32(poolResults[4]);
  const poolPairId = decodeDexBytes32(poolResults[5]);
  const pairId = poolPairId ?? registryPairId;
  const reserves = decodeDexReserves(poolResults[6]);
  const spotPriceX18 = decodeDexUint(poolResults[7]);
  const poolRegistryRead = decodeDexAddressRead(poolResults[8]);
  const poolOrderbookRead = decodeDexAddressRead(poolResults[9]);
  const poolTreasuryRead = decodeDexAddressRead(poolResults[10]);
  const totalShares = decodeDexUint(poolResults[11]);
  const pairIdConsistent = registryPairId !== null && poolPairId !== null
    ? registryPairId.toLowerCase() === poolPairId.toLowerCase()
    : null;
  const pairIdVerified = pairIdConsistent === true && pairId !== null && !/^0x0{64}$/.test(pairId);

  const extraCalls = [] as ReturnType<typeof dexCall>[];
  const tokenIndexes: Array<ExtraIndexes | null> = [null, null];
  const walletIndexes: Array<{ balance: number; allowance: number; orderbookAllowance: number } | null> = [null, null];
  const wallet = normalizeDexAddress(walletAddress);

  [token0Read.address, token1Read.address].forEach((tokenAddress, index) => {
    if (tokenAddress === null) return;
    const indexes: ExtraIndexes = {
      symbol: extraCalls.length,
      decimals: extraCalls.length + 1,
      balance: null,
      allowance: null,
    };
    extraCalls.push(
      dexCall(tokenAddress, encodeDexNoArgs(DEX_SELECTOR.symbol)),
      dexCall(tokenAddress, encodeDexNoArgs(DEX_SELECTOR.decimals)),
    );
    if (wallet) {
      const balance = extraCalls.length;
      const allowance = extraCalls.length + 1;
      const orderbookAllowance = extraCalls.length + 2;
      extraCalls.push(
        dexCall(tokenAddress, encodeErc20BalanceOf(wallet)),
        dexCall(tokenAddress, encodeErc20Allowance(wallet, poolAddress)),
        dexCall(tokenAddress, encodeErc20Allowance(wallet, DEX_CONTRACTS.orderbook)),
      );
      indexes.balance = balance;
      indexes.allowance = allowance;
      walletIndexes[index] = { balance, allowance, orderbookAllowance };
    }
    tokenIndexes[index] = indexes;
  });

  const walletSharesIndex = wallet ? extraCalls.length : null;
  const walletNativeIndex = wallet ? extraCalls.length + 1 : null;
  if (wallet) {
    extraCalls.push(
      dexCall(poolAddress, encodeSharesOf(wallet)),
      { method: 'eth_getBalance', params: [wallet, 'latest'] },
    );
  }

  const orderbookIndexes = pairId && pairIdVerified
    ? {
        bestBid: extraCalls.length,
        bestAsk: extraCalls.length + 1,
        bookConfig: extraCalls.length + 2,
      }
    : null;
  if (pairId && pairIdVerified) {
    extraCalls.push(
      dexCall(DEX_CONTRACTS.orderbook, encodeOrderbookPairRead(DEX_SELECTOR.bestBid, pairId)),
      dexCall(DEX_CONTRACTS.orderbook, encodeOrderbookPairRead(DEX_SELECTOR.bestAsk, pairId)),
      dexCall(DEX_CONTRACTS.orderbook, encodeOrderbookPairRead(DEX_SELECTOR.bookConfig, pairId)),
    );
  }

  const extraResults = await rpcBatch(extraCalls, signal);
  const tokens = [token0Read.address, token1Read.address].map((address, index): DexToken | null => {
    if (!address) return null;
    const indexes = tokenIndexes[index];
    if (!indexes) return { address, symbol: null, decimals: null };
    const decimalsValue = decodeDexUint(extraResults[indexes.decimals]);
    return {
      address,
      symbol: decodeDexTokenSymbol(extraResults[indexes.symbol]),
      decimals: decimalsValue !== null && decimalsValue <= 255n ? Number(decimalsValue) : null,
    };
  });

  const walletTokens: DexWalletSnapshot | null = wallet
    ? {
        address: wallet,
        token0: token0Read.address && walletIndexes[0]
          ? {
              address: token0Read.address,
              balance: decodeDexUint(extraResults[walletIndexes[0].balance]),
              allowance: decodeDexUint(extraResults[walletIndexes[0].allowance]),
              orderbookAllowance: decodeDexUint(extraResults[walletIndexes[0].orderbookAllowance]),
            }
          : null,
        token1: token1Read.address && walletIndexes[1]
          ? {
              address: token1Read.address,
              balance: decodeDexUint(extraResults[walletIndexes[1].balance]),
              allowance: decodeDexUint(extraResults[walletIndexes[1].allowance]),
              orderbookAllowance: decodeDexUint(extraResults[walletIndexes[1].orderbookAllowance]),
            }
          : null,
        shares: walletSharesIndex === null ? null : decodeDexUint(extraResults[walletSharesIndex]),
        // `eth_getBalance` returns a minimal-width quantity, not a padded ABI word.
        native: walletNativeIndex === null ? null : decodeUint(extraResults[walletNativeIndex]),
      }
    : null;

  const orderbook: DexOrderbookSnapshot | null = pairId && orderbookIndexes
    ? {
        pairId,
        bestBid: decodeDexOrderbookLevel(extraResults[orderbookIndexes.bestBid]),
        bestAsk: decodeDexOrderbookLevel(extraResults[orderbookIndexes.bestAsk]),
        bookConfig: decodeDexBookConfig(extraResults[orderbookIndexes.bookConfig]),
      }
    : null;

  const myOrders = wallet !== null && pairId !== null && pairIdVerified && nextOrderId !== null
    ? (await readOrderWindow(nextOrderId, ORDER_SCAN_LIMIT, signal)).filter(({ order }) =>
        order.maker.toLowerCase() === wallet.toLowerCase() &&
        order.pairId.toLowerCase() === pairId.toLowerCase())
    : [];

  const tokenMetadataReady = tokens[0] !== null &&
    tokens[1] !== null &&
    tokens[0].decimals !== null &&
    tokens[1].decimals !== null;
  const reservesReady = reserves !== null;
  const poolRegistryValid = poolRegistryRead.address !== null && sameAddress(poolRegistryRead.address, DEX_CONTRACTS.registry);
  const poolOrderbookValid = poolOrderbookRead.address !== null && sameAddress(poolOrderbookRead.address, DEX_CONTRACTS.orderbook);
  const poolTreasuryValid = poolTreasuryRead.address !== null && sameAddress(poolTreasuryRead.address, DEX_CONTRACTS.protocolTreasury);
  const valid = isSpotPool === true &&
    poolRegistryValid &&
    poolOrderbookValid &&
    poolTreasuryValid &&
    token0Read.address !== null &&
    token1Read.address !== null &&
    tokenMetadataReady &&
    feePpm !== null &&
    pairIdVerified &&
    reservesReady;
  const hasLiquidity = reserves !== null && reserves.reserve0 > 0n && reserves.reserve1 > 0n;
  const reservePriceX18 = reserves !== null && reserves.reserve0 > 0n
    ? reserves.reserve1 * 10n ** 18n / reserves.reserve0
    : null;

  let poolError: string | null = null;
  if (isSpotPool === false) {
    poolError = 'This address is not registered as a SpotPool by DexRegistry.';
  } else if (isSpotPool === null) {
    poolError = 'The SpotPool registry check did not return a safe result.';
  } else if (!poolRegistryRead.ready || !poolRegistryValid) {
    poolError = 'The pool registry link did not resolve to the supplied DexRegistry.';
  } else if (!poolOrderbookRead.ready || !poolOrderbookValid || !poolTreasuryRead.ready || !poolTreasuryValid) {
    poolError = 'The pool wiring does not resolve to the configured Orderbook and ProtocolTreasury.';
  } else if (registryPairId === null || poolPairId === null) {
    poolError = 'Both the registry and pool pair IDs are required for verification.';
  } else if (pairIdConsistent === false) {
    poolError = 'The pool and registry returned different pair IDs.';
  } else if (!pairIdVerified) {
    poolError = 'The pool returned an invalid pair ID.';
  } else if (!reservesReady) {
    poolError = 'Pool reserves were not returned in a valid ABI tuple.';
  } else if (!valid) {
    poolError = 'Pool metadata is incomplete. Writes remain hidden until it can be verified.';
  }

  return {
    loading: false,
    error: null,
    registryWiring,
    pool: {
      address: poolAddress,
      invalidAddress: false,
      isSpotPool,
      registryPairId,
      poolRegistry: poolRegistryRead.address,
      pairId,
      pairIdConsistent,
      poolOrderbook: poolOrderbookRead.address,
      poolTreasury: poolTreasuryRead.address,
      token0: tokens[0],
      token1: tokens[1],
      reserves,
      feePpm,
      spotPriceX18,
      reservePriceX18,
      totalShares,
      valid,
      hasLiquidity,
      error: poolError,
    },
    orderbook,
    positionManager,
    walletTokens,
    nextOrderId,
    myOrders,
  };
}

export function useDex(poolAddress?: string | null, walletAddress: string | null = null): DexState & {
  refresh: () => void;
  readSpotQuote: (tokenIn: string, amountIn: bigint, signal?: AbortSignal) => Promise<bigint | null>;
  simulateSwapExactIn: (tokenIn: string, amountIn: bigint, minAmountOut: bigint, recipient: string, signal?: AbortSignal) => Promise<bigint | null>;
} {
  const selectedPoolAddress = poolAddress === undefined ? DEX_CONFIG.spotPoolAddress : poolAddress;
  const readableWalletAddress = normalizeDexAddress(walletAddress);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [state, setState] = useState<DexState>(createEmptyDexState);

  const refresh = useCallback(() => {
    setRefreshVersion((version) => version + 1);
  }, []);

  useEffect(() => {
    let active = true;
    let timeoutId: number | undefined;
    const controller = new AbortController();
    setState(createEmptyDexState());

    const load = async () => {
      try {
        const nextState = await readDexState(selectedPoolAddress, readableWalletAddress, controller.signal);
        if (active && !controller.signal.aborted) setState(nextState);
      } catch (readError) {
        if (!active || controller.signal.aborted) return;
        setState((previous) => ({
          ...previous,
          loading: false,
          error: readError instanceof Error ? readError.message : 'Could not read the DEX from Monad.',
        }));
      } finally {
        if (active && !controller.signal.aborted) {
          timeoutId = globalThis.setTimeout(() => void load(), DEX_CONFIG.pollIntervalMs);
        }
      }
    };

    void load();
    return () => {
      active = false;
      controller.abort();
      if (timeoutId !== undefined) globalThis.clearTimeout(timeoutId);
    };
  }, [readableWalletAddress, refreshVersion, selectedPoolAddress]);

  const readSpotQuote = useCallback(
    (tokenIn: string, amountIn: bigint, signal?: AbortSignal) => {
      const pool = normalizeDexAddress(selectedPoolAddress);
      return pool ? readDexSpotQuote(pool, tokenIn, amountIn, signal) : Promise.resolve(null);
    },
    [selectedPoolAddress],
  );

  const simulateSwapExactIn = useCallback(
    (tokenIn: string, amountIn: bigint, minAmountOut: bigint, recipient: string, signal?: AbortSignal) => {
      const pool = normalizeDexAddress(selectedPoolAddress);
      if (!pool || !readableWalletAddress) return Promise.resolve(null);
      return simulateDexSwapExactIn(pool, readableWalletAddress, tokenIn, amountIn, minAmountOut, recipient, signal);
    },
    [readableWalletAddress, selectedPoolAddress],
  );

  return { ...state, refresh, readSpotQuote, simulateSwapExactIn };
}
