/**
 * Self-check for the hand-rolled ABI encode/decode and formatting helpers, plus
 * one live read against Monad mainnet.
 *
 * Run: node src/chain.check.ts
 */
import assert from 'node:assert/strict';
import {
  CONTRACTS,
  SELECTOR,
  callWithAddress,
  callWithUint,
  decodeAddress,
  decodeAddressRead,
  decodeBool,
  decodeProfiles,
  decodeString,
  decodeUint,
  ethCall,
  encodeDynamicString,
  encodeUint,
  encodeUpdateProfile,
  formatCompact,
  formatUnits,
  rpcBatch,
  shortenAddress,
} from './chain.ts';
import { fetchGasSeries, fetchIdentityCount } from './useProtocol.ts';

// ── encoding ──────────────────────────────────────────────────────────────────
assert.equal(SELECTOR.image, '0xf3ccaac0');
assert.equal(SELECTOR.description, '0x7284e416');
assert.equal(
  callWithAddress(CONTRACTS.ser9, SELECTOR.balanceOf, '0xD2cF3765C2e600f13470Ed71aaAb0ee3aa37F90a').params[0]
    ? (callWithAddress(CONTRACTS.ser9, SELECTOR.balanceOf, '0xD2cF3765C2e600f13470Ed71aaAb0ee3aa37F90a')
        .params[0] as { data: string }).data
    : '',
  '0x70a08231000000000000000000000000d2cf3765c2e600f13470ed71aaab0ee3aa37f90a',
);
assert.equal(
  (callWithUint(CONTRACTS.identity, SELECTOR.ownerOf, 1n).params[0] as { data: string }).data,
  '0x6352211e0000000000000000000000000000000000000000000000000000000000000001',
);

const updateProfileWord = (data: string, index: number): string => data.slice(10 + index * 64, 10 + (index + 1) * 64);
const encodedUpdateProfile = encodeUpdateProfile(7n, 'S9', '', 200, 80);
assert.equal(encodedUpdateProfile.slice(0, 10), SELECTOR.updateProfile);
assert.equal(updateProfileWord(encodedUpdateProfile, 0), encodeUint(7n));
assert.equal(updateProfileWord(encodedUpdateProfile, 1), encodeUint(160n));
assert.equal(updateProfileWord(encodedUpdateProfile, 2), encodeUint(224n));
assert.equal(updateProfileWord(encodedUpdateProfile, 3), encodeUint(200n));
assert.equal(updateProfileWord(encodedUpdateProfile, 4), encodeUint(80n));
assert.equal(updateProfileWord(encodedUpdateProfile, 7), encodeUint(0n), 'empty bio keeps a valid dynamic string tail');
assert.equal(encodeDynamicString(''), encodeUint(0n));

// ── decoding ──────────────────────────────────────────────────────────────────
assert.equal(decodeUint('0x' + (12345n).toString(16).padStart(64, '0')), 12345n);
assert.equal(decodeUint(null), null);
assert.equal(decodeUint('0x'), null);
assert.equal(decodeBool('0x' + '1'.padStart(64, '0')), true);
assert.equal(decodeBool('0x' + '0'.padStart(64, '0')), false);
assert.equal(decodeAddress('0x' + '0'.repeat(64)), null, 'zero address reads as absent');
assert.deepEqual(decodeAddressRead('0x' + '0'.repeat(64)), { ready: true, address: null });
assert.deepEqual(decodeAddressRead(null), { ready: false, address: null });
assert.equal(
  decodeAddress('0x000000000000000000000000d2cf3765c2e600f13470ed71aaab0ee3aa37f90a'),
  '0xd2cf3765c2e600f13470ed71aaab0ee3aa37f90a',
);

// offset(0x20) + length(6) + "yuchan" padded to 32 bytes
const encodedString =
  '0x' +
  (32n).toString(16).padStart(64, '0') +
  (6n).toString(16).padStart(64, '0') +
  Buffer.from('yuchan', 'utf8').toString('hex').padEnd(64, '0');
assert.equal(decodeString(encodedString), 'yuchan');
assert.equal(decodeString('0x'), null);

const profileNameTail = encodeDynamicString('S9');
const profileBioTail = encodeDynamicString('');
const encodedProfile = `0x${[
  encodeUint(224n),
  encodeUint(288n),
  encodeUint(1n),
  encodeUint(200n),
  encodeUint(80n),
  encodeUint(1n),
  encodeUint(42n),
].join('')}${profileNameTail}${profileBioTail}`;
assert.deepEqual(decodeProfiles(encodedProfile), {
  name: 'S9',
  bio: '',
  entityType: 1n,
  hue: 200n,
  saturation: 80n,
  verified: true,
  registeredAt: 42n,
});
const malformedProfile = `${encodedProfile.slice(0, 10 + 64)}${encodeUint(32n)}${encodedProfile.slice(10 + 128)}`;
assert.equal(decodeProfiles(malformedProfile), null, 'profiles rejects an offset inside the head');

// ── formatting ────────────────────────────────────────────────────────────────
assert.equal(formatUnits(1_500_000_000_000_000_000n, 18, 2), '1.5');
assert.equal(formatUnits(10n ** 18n, 18, 2), '1');
assert.equal(formatUnits(0n, 18, 2), '0');
assert.equal(formatUnits(1_999_999_999_999_999_999n, 18, 2), '1.99', 'truncates, never rounds up');
assert.equal(formatUnits(1234n * 10n ** 18n, 18, 0), '1,234');
assert.equal(formatCompact(211_328_993n * 10n ** 18n), '211.32M');
assert.equal(formatCompact(1_000_017_488_938n * 10n ** 18n), '1.00T');
assert.equal(formatCompact(42n * 10n ** 18n), '42');
assert.equal(shortenAddress('0xD2cF3765C2e600f13470Ed71aaAb0ee3aa37F90a'), '0xD2cF...F90a');

// ── live read ─────────────────────────────────────────────────────────────────
const [block, symbol, image, description, staked, owner] = await rpcBatch([
  { method: 'eth_blockNumber', params: [] },
  ethCall(CONTRACTS.ser9, SELECTOR.symbol),
  ethCall(CONTRACTS.ser9, SELECTOR.image),
  ethCall(CONTRACTS.ser9, SELECTOR.description),
  ethCall(CONTRACTS.staking, SELECTOR.totalStaked),
  callWithUint(CONTRACTS.identity, SELECTOR.ownerOf, 1n),
]);

assert.ok((decodeUint(block) ?? 0n) > 0n, 'block number should advance');
assert.equal(decodeString(symbol), 'SER9');
assert.ok(decodeString(image)?.startsWith('data:image/svg+xml;base64,'), 'SER9 image should be an on-chain SVG data URI');
assert.equal(typeof decodeString(description), 'string', 'SER9 description should decode as a string');
assert.ok((decodeUint(staked) ?? 0n) > 0n, 'staking contract should hold SER9');
assert.ok(decodeAddress(owner), 'identity #1 should have an owner');

// ── derived series ────────────────────────────────────────────────────────────
const head = decodeUint(block)!;
const signal = AbortSignal.timeout(30_000);

// `ownerOf` reverts past the last minted id, so the bisect must land on a real supply.
const identityCount = await fetchIdentityCount(signal);
assert.ok(identityCount !== null && identityCount >= 1, 'at least identity #1 is minted');
const [pastLast] = await rpcBatch([
  callWithUint(CONTRACTS.identity, SELECTOR.ownerOf, BigInt(identityCount! + 1)),
]);
assert.equal(pastLast, null, 'the id after the counted supply must not exist');

// Block results are JSON objects, not hex strings — regression guard for rpcBatch.
const gasSeries = await fetchGasSeries(head, signal);
assert.equal(gasSeries.length, 12);
assert.ok(
  gasSeries.some((value) => value > 0),
  'sampled blocks should report gasUsed',
);

console.log(
  'ok — block', head,
  '| staked', formatCompact(decodeUint(staked)!), decodeString(symbol),
  '| identities', identityCount,
  '| gas samples', gasSeries.filter((value) => value > 0).length + '/12',
);
