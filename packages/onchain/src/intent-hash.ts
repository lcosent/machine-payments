import { keccak256, encodePacked, stringToHex, type Hex } from 'viem';

export interface IntentHashInputs {
  agent_id: string;
  task_id: string;
  merchant: string;
  amount_ceiling_usdc6: bigint;
  expires_at_unix_sec: number;
  nonce: string;
}

/// Deterministic intent hash used as the on-chain commitment for an MPP intent
/// receipt. Mirror of the off-chain receipt's `intent_hash` field. Must match
/// exactly between the MPP service and the smart wallet's escrow call.
export const computeIntentHash = (i: IntentHashInputs): Hex =>
  keccak256(
    encodePacked(
      ['bytes32', 'bytes32', 'bytes32', 'uint256', 'uint64', 'bytes32'],
      [
        keccak256(stringToHex(i.agent_id)),
        keccak256(stringToHex(i.task_id)),
        keccak256(stringToHex(i.merchant)),
        i.amount_ceiling_usdc6,
        BigInt(i.expires_at_unix_sec),
        keccak256(stringToHex(i.nonce)),
      ],
    ),
  );

export const taskIdToBytes32 = (taskId: string): Hex => {
  const bytes = stringToHex(taskId);
  if (bytes.length > 66) {
    return keccak256(stringToHex(taskId));
  }
  return `0x${bytes.slice(2).padEnd(64, '0')}` as Hex;
};
