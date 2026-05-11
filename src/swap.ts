import { swap } from './common/sdk';

const OUTPUT_TOKEN_MINT: string = process.env.BUY_TOKEN_MINT!;
const INPUT_TOKEN_MINT: string = process.env.SELL_TOKEN_MINT!;
const INPUT_AMOUNT: number | undefined = process.env.SELL_TOKEN_AMOUNT
  ? Number(process.env.SELL_TOKEN_AMOUNT)
  : undefined;

(async function () {
  await swap(INPUT_TOKEN_MINT, OUTPUT_TOKEN_MINT, INPUT_AMOUNT);
})();
