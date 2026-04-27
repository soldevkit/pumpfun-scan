import fs from 'fs';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';

export function loadKeypair(privateKey: string): Keypair {
  // try to load privateKey as a filepath
  let loadedKey: Uint8Array;
  if (fs.existsSync(privateKey)) {
    privateKey = fs.readFileSync(privateKey).toString();
  }

  if (privateKey.includes('[') && privateKey.includes(']')) {
    loadedKey = Uint8Array.from(JSON.parse(privateKey));
  } else if (privateKey.includes(',')) {
    loadedKey = Uint8Array.from(privateKey.split(',').map((val) => Number(val)));
  } else {
    privateKey = privateKey.replace(/\s/g, '');
    loadedKey = new Uint8Array(bs58.decode(privateKey));
  }

  const keypair = Keypair.fromSecretKey(Uint8Array.from(loadedKey));
  console.log('Loaded wallet:', keypair.publicKey.toBase58());
  console.log('\n');

  return keypair;
}
