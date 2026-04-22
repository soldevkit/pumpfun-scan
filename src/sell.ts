import { sellToken } from './sdk';

const SELL_TOKEN_MINT: string = process.env.SELL_TOKEN_MINT!;
const SELL_TOKEN_AMOUNT: number | undefined = process.env.SELL_TOKEN_AMOUNT
  ? Number(process.env.SELL_TOKEN_AMOUNT)
  : undefined;

(async function () {
  await sellToken(SELL_TOKEN_MINT, SELL_TOKEN_AMOUNT);
})();
