import { buyToken } from './common/sdk';

const BUY_TOKEN_MINT: string = process.env.BUY_TOKEN_MINT!;
const BUY_SOL_AMOUNT: number | undefined = process.env.BUY_SOL_AMOUNT
  ? Number(process.env.BUY_SOL_AMOUNT)
  : undefined;

(async function () {
  await buyToken(BUY_TOKEN_MINT, BUY_SOL_AMOUNT);
})();
