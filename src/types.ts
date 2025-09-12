export type PublicKeyString = string;
export type UrlString = string;
export type UnixTimestamp = number;

export type PumpfunCoin = {
  coinMint: PublicKeyString;
  dev: PublicKeyString;
  name: string;
  ticker: string;
  imageUrl: UrlString;
  creationTime: UnixTimestamp;
  numHolders: number;
  marketCap: number;
  volume: number;
  currentMarketPrice: number;
  bondingCurveProgress: number;
  sniperCount: number;
  graduationDate: UnixTimestamp;
  allTimeHighMarketCap: number;
  poolAddress: PublicKeyString;
  hasTwitter: boolean;
  hasTelegram: boolean;
  hasWebsite: boolean;
  hasSocial: boolean;
  twitterReuseCount: number;
  devHoldingsPercentage: number;
  buyTransactions: number;
  sellTransactions: number;
  transactions: number;
  sniperOwnedPercentage: number;
  topHoldersPercentage: number;
};

export type PumpfunGraduatedCoins = {
  coins: PumpfunCoin[];
  pagination: {
    lastScore: number;
    hasMore: boolean;
  };
};
