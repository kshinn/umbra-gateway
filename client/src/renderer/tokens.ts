export interface Token {
  symbol: string
  name: string
  decimals: number
  /** null for native ETH */
  address: string | null
  /** Single char shown in the logo circle */
  logoChar: string
  /** Tailwind bg color class for the logo circle */
  logoBg: string
}

export const TOKENS: Token[] = [
  {
    symbol: 'ETH',
    name: 'Ether',
    decimals: 18,
    address: null,
    logoChar: 'Ξ',
    logoBg: 'bg-blue-500',
  },
  {
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
    address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    logoChar: '$',
    logoBg: 'bg-emerald-500',
  },
]
