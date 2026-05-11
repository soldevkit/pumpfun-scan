import fs from 'fs';
import path from 'path';
import { table } from 'table';
import { loadKeypair, sleep } from './common/helper';
import { connection } from './common/sdk';
import { PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';

const DIR = process.cwd() + '/../__keypair/';

async function getBalances() {
  let totalLamports: number = 0;
  let totalAmount: number = 0;

  const data: (string | number)[][] = [['address', 'alias', 'weight', 'score']];

  const files = fs.readdirSync(DIR);
  for (const file of files.filter((name) => name.endsWith('.json'))) {
    const pk = loadKeypair(DIR + file);
    const address = pk.publicKey.toBase58();

    const lamports = await connection.getBalance(pk.publicKey);
    let amount = 0;
    try {
      const { value } = await connection.getTokenAccountBalance(
        getAssociatedTokenAddressSync(
          new PublicKey('i6WHmUrxjVDNyDzL8ivMmR8xNkZxdZmgPGP4HHLpump'),
          pk.publicKey,
          true,
          TOKEN_2022_PROGRAM_ID,
        ),
      );
      amount = value.uiAmount || 0;
    } catch {}
    await sleep(1500);

    data.push([
      address.slice(0, 6) + '...' + address.slice(-6),
      path.basename(file, '.json'),
      lamports / 1e9,
      amount,
    ]);
    totalLamports += lamports;
    totalAmount += amount;
  }

  data.push(['So1111...111111', '', totalLamports / 1e9, totalAmount]);

  console.log(table(data));
}

(async () => {
  await getBalances();
})();
