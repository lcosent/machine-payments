import { json } from '../../../../../lib/route-helpers';
import { DcompProviderIdentity } from '../../../../../lib/provider-state';

/// Returns the dcomp mock provider's EOA address — needed by the agent when
/// opening a Tier 3 escrow so `Escrow.openJob(provider, ...)` is set to the
/// address whose signature will later satisfy `Escrow.settle`'s ECDSA check.
export async function GET(): Promise<Response> {
  return json({ provider_address: DcompProviderIdentity.address() });
}
