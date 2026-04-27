import { depositPrivacyPool } from './common/sdk';

const PRIVACY_DEP_AMOUNT: number | undefined = Number(process.env.PRIVACY_DEP_AMOUNT!);

(async function () {
  await depositPrivacyPool(PRIVACY_DEP_AMOUNT);
})();
