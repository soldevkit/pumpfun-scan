import { table } from 'table';
import millify from 'millify';
import TimeAgo from 'javascript-time-ago';
import en from 'javascript-time-ago/locale/en';
import { PumpfunGraduatedCoins } from './types';

TimeAgo.addDefaultLocale(en);
const timeAgo = new TimeAgo('en-US');

const MIN_HOLDERS = 33;
const MAX_SNIPERS_PCT = 3;
const MAX_TOP_HOLDERS_PCT = 33;
const MIN_MC = 3333;
const MC_ATH_THRESHOLD = 0.5; // 50%

(async () => {
  const res = await fetch(
    `https://advanced-api-v2.pump.fun/coins/graduated?sortBy=creationTime&marketCapFrom=${MIN_MC}&numHoldersFrom=${MIN_HOLDERS}&snipersOwnedPercentageTo=${MAX_SNIPERS_PCT}&topTenHoldersOwnedPercentageTo=${MAX_TOP_HOLDERS_PCT}`,
  );
  const data: PumpfunGraduatedCoins = await res.json();

  const printData: (string | number)[][] = [
    [
      'Name',
      'Mint',
      'V (SOL)',
      'MC',
      'ATH',
      'Holders',
      'Snipers %',
      'Top %',
      'Website',
      'X',
      'TG',
      'Social',
      'Graduated',
    ],
  ];

  printData.push(
    ...data.coins
      .filter((coin) => coin.marketCap > coin.allTimeHighMarketCap * MC_ATH_THRESHOLD)
      .map((coin) => [
        `${coin.name} (${coin.ticker})`,
        coin.coinMint,
        millify(coin.volume),
        millify(coin.marketCap) +
          (coin.marketCap > 1000000
            ? ' 🔥'
            : coin.marketCap > 500000
              ? ' 🚀'
              : coin.marketCap > 250000
                ? ' 💎'
                : coin.marketCap > 125000
                  ? ' 🌱'
                  : ''),
        millify(coin.allTimeHighMarketCap),
        coin.numHolders.toLocaleString('en-US') + (coin.numHolders > 1000 ? ' 🏆' : ''),
        coin.sniperOwnedPercentage.toLocaleString('en-US', {
          style: 'percent',
          maximumFractionDigits: 2,
        }),
        (coin.topHoldersPercentage / 100).toLocaleString('en-US', {
          style: 'percent',
          maximumFractionDigits: 2,
        }),
        coin.hasWebsite ? 'Y' : 'N',
        coin.hasTwitter ? 'Y' : 'N',
        coin.hasTelegram ? 'Y' : 'N',
        coin.hasSocial ? 'Y' : 'N',
        timeAgo.format(coin.graduationDate),
      ]),
  );

  console.log(table(printData));
})();
