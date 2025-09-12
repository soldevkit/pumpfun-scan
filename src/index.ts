import { table } from 'table';
import millify from 'millify';
import TimeAgo from 'javascript-time-ago';
import en from 'javascript-time-ago/locale/en';
import { PumpfunGraduatedCoins } from './types';

TimeAgo.addDefaultLocale(en);
const timeAgo = new TimeAgo('en-US');

(async () => {
  const res = await fetch(
    'https://advanced-api-v2.pump.fun/coins/graduated?sortBy=creationTime&marketCapFrom=33333&numHoldersFrom=333&snipersOwnedPercentageTo=3&topTenHoldersOwnedPercentageTo=33',
  );
  const data: PumpfunGraduatedCoins = await res.json();

  const printData: (string | number)[][] = [
    [
      'Mint',
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
    ...data.coins.map((coin) => [
      coin.coinMint,
      millify(coin.marketCap),
      millify(coin.allTimeHighMarketCap),
      coin.numHolders.toLocaleString('en-US'),
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
