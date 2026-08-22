/**
 * Minimal keccak-256 over 32-bit lanes.
 *
 * The DEX registry keys every pair by `keccak256(abi.encodePacked(token0, token1))`
 * with the two addresses sorted ascending, so the client needs a hash to look up
 * pools from a token pair. That is the only reason this exists: no crypto library
 * is worth the bundle for one 136-byte-rate sponge.
 */

const ROUND_CONSTANTS: Array<[number, number]> = [
  [0x00000000, 0x00000001], [0x00000000, 0x00008082], [0x80000000, 0x0000808a], [0x80000000, 0x80008000],
  [0x00000000, 0x0000808b], [0x00000000, 0x80000001], [0x80000000, 0x80008081], [0x80000000, 0x00008009],
  [0x00000000, 0x0000008a], [0x00000000, 0x00000088], [0x00000000, 0x80008009], [0x00000000, 0x8000000a],
  [0x00000000, 0x8000808b], [0x80000000, 0x0000008b], [0x80000000, 0x00008089], [0x80000000, 0x00008003],
  [0x80000000, 0x00008002], [0x80000000, 0x00000080], [0x00000000, 0x0000800a], [0x80000000, 0x8000000a],
  [0x80000000, 0x80008081], [0x80000000, 0x00008080], [0x00000000, 0x80000001], [0x80000000, 0x80008008],
];

/** Rho offsets indexed by `x + 5y`. */
const ROTATIONS = [0, 1, 190, 28, 91, 36, 300, 6, 55, 276, 3, 10, 171, 153, 231, 105, 45, 15, 21, 136, 210, 66, 253, 120, 78];

const RATE_BYTES = 136;
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

function rotateLeft(high: number, low: number, rawShift: number): [number, number] {
  const shift = rawShift % 64;
  if (shift === 0) return [high, low];
  if (shift < 32) {
    return [(high << shift) | (low >>> (32 - shift)), (low << shift) | (high >>> (32 - shift))];
  }
  const offset = shift - 32;
  if (offset === 0) return [low, high];
  return [(low << offset) | (high >>> (32 - offset)), (high << offset) | (low >>> (32 - offset))];
}

function permute(state: Int32Array): void {
  const parity = new Int32Array(10);
  const scratch = new Int32Array(50);

  for (let round = 0; round < 24; round += 1) {
    for (let x = 0; x < 5; x += 1) {
      let high = 0;
      let low = 0;
      for (let y = 0; y < 5; y += 1) {
        high ^= state[2 * (x + 5 * y)];
        low ^= state[2 * (x + 5 * y) + 1];
      }
      parity[2 * x] = high;
      parity[2 * x + 1] = low;
    }

    for (let x = 0; x < 5; x += 1) {
      const [rotatedHigh, rotatedLow] = rotateLeft(parity[2 * ((x + 1) % 5)], parity[2 * ((x + 1) % 5) + 1], 1);
      const deltaHigh = parity[2 * ((x + 4) % 5)] ^ rotatedHigh;
      const deltaLow = parity[2 * ((x + 4) % 5) + 1] ^ rotatedLow;
      for (let y = 0; y < 5; y += 1) {
        state[2 * (x + 5 * y)] ^= deltaHigh;
        state[2 * (x + 5 * y) + 1] ^= deltaLow;
      }
    }

    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        const source = x + 5 * y;
        const [high, low] = rotateLeft(state[2 * source], state[2 * source + 1], ROTATIONS[source]);
        const target = y + 5 * ((2 * x + 3 * y) % 5);
        scratch[2 * target] = high;
        scratch[2 * target + 1] = low;
      }
    }

    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        const index = x + 5 * y;
        const next = (x + 1) % 5 + 5 * y;
        const after = (x + 2) % 5 + 5 * y;
        state[2 * index] = scratch[2 * index] ^ (~scratch[2 * next] & scratch[2 * after]);
        state[2 * index + 1] = scratch[2 * index + 1] ^ (~scratch[2 * next + 1] & scratch[2 * after + 1]);
      }
    }

    state[0] ^= ROUND_CONSTANTS[round][0];
    state[1] ^= ROUND_CONSTANTS[round][1];
  }
}

export function keccak256(bytes: Uint8Array): Uint8Array {
  const state = new Int32Array(50);
  const padded = new Uint8Array(Math.ceil((bytes.length + 1) / RATE_BYTES) * RATE_BYTES);
  padded.set(bytes);
  padded[bytes.length] = 0x01;
  padded[padded.length - 1] |= 0x80;

  for (let offset = 0; offset < padded.length; offset += RATE_BYTES) {
    for (let lane = 0; lane < RATE_BYTES / 8; lane += 1) {
      const base = offset + lane * 8;
      const low = padded[base] | (padded[base + 1] << 8) | (padded[base + 2] << 16) | (padded[base + 3] << 24);
      const high = padded[base + 4] | (padded[base + 5] << 8) | (padded[base + 6] << 16) | (padded[base + 7] << 24);
      state[2 * lane] ^= high;
      state[2 * lane + 1] ^= low;
    }
    permute(state);
  }

  const digest = new Uint8Array(32);
  for (let lane = 0; lane < 4; lane += 1) {
    const high = state[2 * lane];
    const low = state[2 * lane + 1];
    digest[lane * 8] = low & 0xff;
    digest[lane * 8 + 1] = (low >>> 8) & 0xff;
    digest[lane * 8 + 2] = (low >>> 16) & 0xff;
    digest[lane * 8 + 3] = (low >>> 24) & 0xff;
    digest[lane * 8 + 4] = high & 0xff;
    digest[lane * 8 + 5] = (high >>> 8) & 0xff;
    digest[lane * 8 + 6] = (high >>> 16) & 0xff;
    digest[lane * 8 + 7] = (high >>> 24) & 0xff;
  }
  return digest;
}

function hexToBytes(hex: string): Uint8Array {
  const body = hex.replace(/^0x/, '');
  const bytes = new Uint8Array(body.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = parseInt(body.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export function keccak256Hex(hex: string): string {
  const digest = keccak256(hexToBytes(hex));
  return `0x${Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * `keccak256(abi.encodePacked(token0, token1))` with the pair sorted ascending,
 * matching `DexRegistry`'s on-chain pair key.
 */
export function computePairId(tokenA: string, tokenB: string): string | null {
  if (!ADDRESS_PATTERN.test(tokenA) || !ADDRESS_PATTERN.test(tokenB)) return null;

  const left = tokenA.slice(2).toLowerCase();
  const right = tokenB.slice(2).toLowerCase();
  if (left === right) return null;

  const [token0, token1] = left < right ? [left, right] : [right, left];
  return keccak256Hex(token0 + token1);
}

/** The order `SpotPool` stores its two tokens in, so the UI can label amounts before a pool exists. */
export function sortTokenPair(tokenA: string, tokenB: string): [string, string] | null {
  if (!ADDRESS_PATTERN.test(tokenA) || !ADDRESS_PATTERN.test(tokenB)) return null;
  const left = tokenA.toLowerCase();
  const right = tokenB.toLowerCase();
  if (left === right) return null;
  return left < right ? [left, right] : [right, left];
}
