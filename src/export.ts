import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import fs from 'fs';
import dotenv from 'dotenv';
import { loadKeypair } from './common/helper';

dotenv.config();

// your JSON array
const wallet = loadKeypair(process.env.WALLET_KEYPAIR!);

// encode to base58
const base58 = bs58.encode(wallet.secretKey);

// write to file
fs.writeFileSync(process.env.WALLET_KEYPAIR!.replace('.json', '.key'), base58, {
  encoding: 'utf-8',
  mode: 0o600, // 🔒 owner read/write only
});

console.log('Private key exported');
