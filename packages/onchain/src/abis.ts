export const ESCROW_ABI = [
  {
    type: 'function',
    name: 'openJob',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'provider', type: 'address' },
      { name: 'amount', type: 'uint96' },
      { name: 'deadline', type: 'uint64' },
      { name: 'intentHash', type: 'bytes32' },
      { name: 'taskId', type: 'bytes32' },
    ],
    outputs: [{ name: 'jobId', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'meter',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'jobId', type: 'uint256' },
      { name: 'progressBps', type: 'uint16' },
      { name: 'consumed', type: 'uint96' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'settle',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'jobId', type: 'uint256' },
      { name: 'finalAmount', type: 'uint96' },
      { name: 'providerSig', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'refund',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'jobId', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'event',
    name: 'JobOpened',
    inputs: [
      { indexed: true, name: 'jobId', type: 'uint256' },
      { indexed: true, name: 'payer', type: 'address' },
      { indexed: true, name: 'provider', type: 'address' },
      { indexed: false, name: 'amount', type: 'uint96' },
      { indexed: false, name: 'deadline', type: 'uint64' },
      { indexed: false, name: 'intentHash', type: 'bytes32' },
      { indexed: false, name: 'taskId', type: 'bytes32' },
    ],
  },
  {
    type: 'event',
    name: 'JobSettled',
    inputs: [
      { indexed: true, name: 'jobId', type: 'uint256' },
      { indexed: false, name: 'finalAmount', type: 'uint96' },
      { indexed: false, name: 'refunded', type: 'uint96' },
    ],
  },
  {
    type: 'event',
    name: 'JobRefunded',
    inputs: [
      { indexed: true, name: 'jobId', type: 'uint256' },
      { indexed: false, name: 'refunded', type: 'uint96' },
    ],
  },
] as const;

export const CREDIT_LINE_ABI = [
  {
    type: 'function',
    name: 'depositCollateral',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'amount', type: 'uint128' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'borrow',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'amount', type: 'uint128' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'repay',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'amount', type: 'uint128' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'accounts',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }],
    outputs: [
      { name: 'collateral', type: 'uint128' },
      { name: 'principal', type: 'uint128' },
      { name: 'lastAccrual', type: 'uint64' },
    ],
  },
  {
    type: 'event',
    name: 'Borrowed',
    inputs: [
      { indexed: true, name: 'account', type: 'address' },
      { indexed: false, name: 'amount', type: 'uint128' },
    ],
  },
  {
    type: 'event',
    name: 'Repaid',
    inputs: [
      { indexed: true, name: 'account', type: 'address' },
      { indexed: false, name: 'principal', type: 'uint128' },
      { indexed: false, name: 'interest', type: 'uint128' },
    ],
  },
] as const;

export const USDC_ABI = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;
