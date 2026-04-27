import { withdrawPrivacyPool } from './common/sdk';

const PRIVACY_RECIPIENT: string = process.env.PRIVACY_RECIPIENT!;
const PRIVACY_WID_AMOUNT: number | undefined = Number(process.env.PRIVACY_WID_AMOUNT!);

(async function () {
  await withdrawPrivacyPool(PRIVACY_RECIPIENT, PRIVACY_WID_AMOUNT);
})();
