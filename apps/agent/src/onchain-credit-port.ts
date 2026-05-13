import {
  drawCredit,
  repayCredit,
  type Address,
  type AgentWallet,
  type Hex,
} from '@autocompute/onchain';
import type { CreditPort } from './handlers.js';

export interface OnchainCreditPortConfig {
  wallet: AgentWallet;
  usdc: Address;
  creditLine: Address;
  /// Pre-flight gate. Throw to reject the spend before the wallet broadcasts.
  /// Use this to enforce a session-key allowlist on the agent's wallet without
  /// modifying the credit-line contract itself.
  sessionKeyPolicy?: (call: { kind: 'draw' | 'repay'; amount_usd: number }) => void;
}

/// Onchain CreditPort that calls into Morpho-shaped CreditLine.sol via
/// packages/onchain. Drop-in for the in-memory CreditPort used by
/// scripts/agent.ts once CREDIT_LINE_ADDRESS + USDC_ADDRESS are populated
/// from the deploy script.
export class OnchainCreditPort implements CreditPort {
  private readonly cfg: OnchainCreditPortConfig;

  constructor(cfg: OnchainCreditPortConfig) {
    this.cfg = cfg;
  }

  async draw(amount_usd: number): Promise<{ onchain_tx_hash: Hex }> {
    this.cfg.sessionKeyPolicy?.({ kind: 'draw', amount_usd });
    const { borrowTx } = await drawCredit({
      creditLine: this.cfg.creditLine,
      usdc: this.cfg.usdc,
      wallet: this.cfg.wallet,
      amountUsd: amount_usd,
    });
    return { onchain_tx_hash: borrowTx };
  }

  async repay(amount_usd: number): Promise<{ onchain_tx_hash: Hex }> {
    this.cfg.sessionKeyPolicy?.({ kind: 'repay', amount_usd });
    const { repayTx } = await repayCredit({
      creditLine: this.cfg.creditLine,
      usdc: this.cfg.usdc,
      wallet: this.cfg.wallet,
      amountUsd: amount_usd,
    });
    return { onchain_tx_hash: repayTx };
  }
}
