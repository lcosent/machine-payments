import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, keccak256, pad, toBytes, toHex, type Address, type Hex } from 'viem';
import { decodeJobOpenedJobId } from './escrow.js';

const ESCROW: Address = '0x1111111111111111111111111111111111111111';
const OTHER: Address = '0x2222222222222222222222222222222222222222';
const PAYER: Address = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PROVIDER: Address = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const JOB_OPENED_SIG = 'JobOpened(uint256,address,address,uint96,uint64,bytes32,bytes32)';
const JOB_OPENED_TOPIC = keccak256(toBytes(JOB_OPENED_SIG));

const encodeJobOpened = (jobId: bigint): { topics: Hex[]; data: Hex } => {
  return {
    topics: [
      JOB_OPENED_TOPIC,
      pad(toHex(jobId), { size: 32 }),
      pad(PAYER, { size: 32 }),
      pad(PROVIDER, { size: 32 }),
    ],
    data: encodeAbiParameters(
      [
        { type: 'uint96', name: 'amount' },
        { type: 'uint64', name: 'deadline' },
        { type: 'bytes32', name: 'intentHash' },
        { type: 'bytes32', name: 'taskId' },
      ],
      [80_000_000n, 1_700_000_600n, pad('0xabc', { size: 32 }), pad('0xdef', { size: 32 })],
    ),
  };
};

describe('decodeJobOpenedJobId', () => {
  it('decodes the jobId out of a JobOpened log emitted by the escrow', () => {
    const { topics, data } = encodeJobOpened(42n);
    const got = decodeJobOpenedJobId([{ address: ESCROW, topics, data }], ESCROW);
    expect(got).toBe(42n);
  });

  it('skips logs from other addresses', () => {
    const { topics, data } = encodeJobOpened(42n);
    const got = decodeJobOpenedJobId([{ address: OTHER, topics, data }], ESCROW);
    expect(got).toBeNull();
  });

  it('skips unrelated logs from the escrow and finds the JobOpened later in the list', () => {
    const meterTopic = keccak256(toBytes('JobMetered(uint256,uint16,uint96)'));
    const dummy = { address: ESCROW, topics: [meterTopic], data: '0x' as Hex };
    const { topics, data } = encodeJobOpened(99n);
    const got = decodeJobOpenedJobId([dummy, { address: ESCROW, topics, data }], ESCROW);
    expect(got).toBe(99n);
  });

  it('returns null when no JobOpened log is present', () => {
    expect(decodeJobOpenedJobId([], ESCROW)).toBeNull();
  });

  it('handles a uint256 jobId greater than Number.MAX_SAFE_INTEGER', () => {
    const big = 9_007_199_254_740_993n;
    const { topics, data } = encodeJobOpened(big);
    const got = decodeJobOpenedJobId([{ address: ESCROW, topics, data }], ESCROW);
    expect(got).toBe(big);
  });
});
