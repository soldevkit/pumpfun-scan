import { jupiterBorrow } from './common/sdk';

(async function () {
  // https://jup.ag/lend/borrow/28/actions/deposit
  await jupiterBorrow(35, 0, 0);

  // https://jup.ag/lend/borrow/28/actions/borrow
  // await jupiterBorrow(28, 0, 0.02);
})();
