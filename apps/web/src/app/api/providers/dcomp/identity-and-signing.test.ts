import { describe, expect, it } from 'vitest';
import {
  encodePacked,
  hashMessage,
  keccak256,
  recoverAddress,
  toBytes,
  type Address,
  type Hex,
} from 'viem';
import { POST as startPost } from './start/route';
import { POST as settlePost } from './settle/route';
import { GET as identityGet } from './identity/route';
import { DcompStore } from '../../../../lib/provider-state';

const TASK = 'task_01J0000000000000000000000A';
const INTENT_HASH = `0x${'a'.repeat(64)}`;
// Real-looking Ethereum address (20 bytes hex). Doesn't have to be a contract
// that exists — we just need to compute the digest matching what
// Escrow.sol would compute on Base Sepolia.
const ESCROW_ADDRESS = '0x1111111111111111111111111111111111111111';

const post = (url: string, body: unknown) =>
  new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('dcomp /identity + /settle real signature', () => {
  it('exposes a stable EOA at /identity', async () => {
    const a = await (await identityGet()).json();
    const b = await (await identityGet()).json();
    expect(a.provider_address).toMatch(/^0x[0-9a-f]{40}$/i);
    expect(a.provider_address).toBe(b.provider_address);
  });

  it('produces a signature that recovers to the published address', async () => {
    DcompStore.__reset();
    // 1. Open a job.
    const startResp = await startPost(
      post('http://x/api/providers/dcomp/start', {
        task_id: TASK,
        intent_hash: INTENT_HASH,
        amount_ceiling_usd: 80,
      }),
    );
    const { job_id } = (await startResp.json()) as { job_id: string };

    // 2. The on-chain caller would use a uint256 jobId from the JobOpened
    //    event. The mock provider doesn't care what number you pass, only
    //    that it matches what the on-chain settle() will check.
    const JOB_ID_UINT = '42';

    // 3. Ask the mock to sign the real escrow digest.
    const settleResp = await settlePost(
      post('http://x/api/providers/dcomp/settle', {
        job_id,
        final_amount_usd: 78,
        escrow_address: ESCROW_ADDRESS,
        job_id_uint: JOB_ID_UINT,
      }),
    );
    const { merchant_signature } = (await settleResp.json()) as { merchant_signature: Hex };
    expect(merchant_signature).toMatch(/^0x[0-9a-f]{130}$/i);

    // 4. Recompute the digest and recover the signer. This is exactly the
    //    sequence Escrow.sol's settle() runs: keccak over packed args, then
    //    EIP-191 (toEthSignedMessageHash), then ecrecover.
    const finalAmountUsdc6 = BigInt(Math.round(78 * 1_000_000));
    const inner = keccak256(
      encodePacked(
        ['address', 'uint256', 'uint96'],
        [ESCROW_ADDRESS as Address, BigInt(JOB_ID_UINT), finalAmountUsdc6],
      ),
    );
    const digest = hashMessage({ raw: toBytes(inner) });
    const recovered = await recoverAddress({ hash: digest, signature: merchant_signature });

    const identity = (await (await identityGet()).json()) as { provider_address: string };
    expect(recovered.toLowerCase()).toBe(identity.provider_address.toLowerCase());
  });

  it('falls back to the mock-hash signature when escrow_address is omitted', async () => {
    DcompStore.__reset();
    const startResp = await startPost(
      post('http://x/api/providers/dcomp/start', {
        task_id: TASK,
        intent_hash: INTENT_HASH,
        amount_ceiling_usd: 80,
      }),
    );
    const { job_id } = (await startResp.json()) as { job_id: string };

    const settleResp = await settlePost(
      post('http://x/api/providers/dcomp/settle', {
        job_id,
        final_amount_usd: 78,
      }),
    );
    const { merchant_signature } = (await settleResp.json()) as { merchant_signature: string };
    // Mock-hash format is the short 32-bit-repeated string, very far from
    // a 65-byte ECDSA signature.
    expect(merchant_signature.length).toBeLessThan(80);
  });
});
