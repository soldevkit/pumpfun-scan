import fs from 'fs';
import bs58 from 'bs58';
import BN from 'bn.js';
import { createJupiterApiClient } from '@jup-ag/api';
import {
  OnlinePumpSdk,
  PUMP_SDK,
  getBuyTokenAmountFromSolAmount,
  getSellSolAmountFromTokenAmount,
} from '@pump-fun/pump-sdk';
import { getAssociatedTokenAddressSync, NATIVE_MINT } from '@solana/spl-token';
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  TransactionSignature,
  VersionedTransaction,
} from '@solana/web3.js';

import dotenv from 'dotenv';
dotenv.config();

const ZERO = new BN(0);
const NATIVE_MINT_ADDRESS = NATIVE_MINT.toBase58();
const RPC_URL = 'https://willie-l4msmu-fast-mainnet.helius-rpc.com';

// RPC connection
const connection = new Connection(RPC_URL, 'confirmed');

const pumpSdk = new OnlinePumpSdk(connection);
const jupiterApi = createJupiterApiClient({ basePath: 'https://lite-api.jup.ag' });

const wallet = loadKeypair(process.env.WALLET_KEYPAIR!);

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
  console.log('loaded wallet:', keypair.publicKey.toBase58());

  return keypair;
}

export async function getTokenProgram(mintPubkey: PublicKey): Promise<PublicKey> {
  const mintInfo = await connection.getAccountInfo(mintPubkey);
  if (!mintInfo) throw new Error('Mint not found');

  return mintInfo.owner;
}

export async function getTokenAmount(mint: string): Promise<BN> {
  if (mint === NATIVE_MINT_ADDRESS) {
    const lamports = await connection.getBalance(wallet.publicKey);
    if (lamports > 0.05e9) {
      return new BN(lamports);
    } else {
      return ZERO;
    }
  } else {
    const inputMintPubkey = new PublicKey(mint);
    const tokenProgram = await getTokenProgram(inputMintPubkey);
    const { value: tokenAmount } = await connection.getTokenAccountBalance(
      getAssociatedTokenAddressSync(inputMintPubkey, wallet.publicKey, false, tokenProgram),
    );
    return new BN(tokenAmount.amount);
  }
}

export async function sendTransaction(
  ixs: TransactionInstruction[],
): Promise<TransactionSignature> {
  // --- build + send tx ---
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

  // (optional but highly recommended for Pump)
  const computeIxs = [
    ComputeBudgetProgram.setComputeUnitLimit({
      units: 300_000,
    }),
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: 50_000, // adjust based on priority needs
    }),
  ];

  const message = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: blockhash,
    instructions: [...computeIxs, ...ixs],
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);

  // sign
  tx.sign([wallet]);

  // send (fast path)
  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,
    maxRetries: 2,
  });

  // confirm (important for reliability)
  await connection.confirmTransaction(
    {
      signature,
      blockhash,
      lastValidBlockHeight,
    },
    'confirmed',
  );

  return signature;
}

export async function jupiterSwap(
  inputMint: string,
  outputMint: string,
  amount: BN,
  slippage: number = 0.05,
) {
  const quoteResponse = await jupiterApi.quoteGet({
    inputMint,
    outputMint,
    amount: amount.toNumber(),
    dynamicSlippage: true,
  });

  console.log('Dynamic slippage bps:', quoteResponse.slippageBps);
  console.log('Out amount:', quoteResponse.outAmount);

  const slippageBps = slippage * 1e4;
  if (quoteResponse.slippageBps > slippageBps) {
    throw new Error(`slippage exceeded: ${quoteResponse.slippageBps} / ${slippageBps}`);
  }

  const { swapTransaction } = await jupiterApi.swapPost({
    swapRequest: {
      quoteResponse,
      userPublicKey: wallet.publicKey.toBase58(),
      dynamicSlippage: false,
      wrapAndUnwrapSol: true,
    },
  });

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const txBuff = Buffer.from(swapTransaction, 'base64');
  const tx = VersionedTransaction.deserialize(txBuff);
  tx.message.recentBlockhash = blockhash;
  tx.sign([wallet]);

  // send (fast path)
  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,
    maxRetries: 2,
  });

  // confirm (important for reliability)
  await connection.confirmTransaction(
    {
      signature,
      blockhash,
      lastValidBlockHeight,
    },
    'confirmed',
  );

  return signature;
}

export async function buyToken(
  mint: string,
  solAmount?: number, // in SOL
  slippage: number = 0.05, // 5%
) {
  let lamports: BN;
  if (solAmount === undefined) {
    lamports = await getTokenAmount(mint);
  } else {
    lamports = new BN(Math.floor(solAmount * LAMPORTS_PER_SOL));
  }

  if (lamports.eq(ZERO)) return;

  const mintPubkey = new PublicKey(mint);
  const tokenProgram = await getTokenProgram(mintPubkey);

  const [buyState, global, feeConfig] = await Promise.all([
    pumpSdk.fetchBuyState(mintPubkey, wallet.publicKey, tokenProgram),
    pumpSdk.fetchGlobal(),
    pumpSdk.fetchFeeConfig(),
  ]);

  if (buyState.bondingCurve.complete) {
    const signature = await jupiterSwap(NATIVE_MINT_ADDRESS, mint, lamports, slippage);
    console.log('txid:', signature);
  } else {
    const expectedTokens = getBuyTokenAmountFromSolAmount({
      global,
      feeConfig,
      mintSupply: buyState.bondingCurve.tokenTotalSupply,
      bondingCurve: buyState.bondingCurve,
      amount: lamports,
    });
    console.log('Out amount:', expectedTokens.toNumber());

    const buyIxs = await PUMP_SDK.buyInstructions({
      global,
      ...buyState,
      mint: mintPubkey,
      user: wallet.publicKey,
      amount: expectedTokens,
      solAmount: lamports,
      slippage,
      tokenProgram,
    });

    const signature = await sendTransaction(buyIxs);
    console.log('txid:', signature);
  }
}

export async function sellToken(
  mint: string,
  tokenAmount?: number, // human-readable (e.g. 1000 tokens)
  slippage: number = 0.05,
) {
  let amount: BN;
  if (tokenAmount === undefined) {
    amount = await getTokenAmount(mint);
  } else {
    amount = new BN(Math.floor(tokenAmount * 1e6));
  }

  if (amount.eq(ZERO)) return;

  const mintPubkey = new PublicKey(mint);
  const tokenProgram = await getTokenProgram(mintPubkey);

  const [sellState, global, feeConfig] = await Promise.all([
    pumpSdk.fetchSellState(mintPubkey, wallet.publicKey, tokenProgram),
    pumpSdk.fetchGlobal(),
    pumpSdk.fetchFeeConfig(),
  ]);

  if (sellState.bondingCurve.complete) {
    const signature = await jupiterSwap(mint, NATIVE_MINT_ADDRESS, amount, slippage);
    console.log('txid:', signature);
  } else {
    const expectedLamports = getSellSolAmountFromTokenAmount({
      global,
      feeConfig,
      mintSupply: sellState.bondingCurve.tokenTotalSupply,
      bondingCurve: sellState.bondingCurve,
      amount,
    });
    console.log('Out amount:', expectedLamports.toNumber());

    const sellIxs = await PUMP_SDK.sellInstructions({
      global,
      ...sellState,
      mint: mintPubkey,
      user: wallet.publicKey,
      amount,
      solAmount: expectedLamports,
      slippage,
      mayhemMode: sellState.bondingCurve.isMayhemMode,
      cashback: sellState.bondingCurve.isCashbackCoin,
      tokenProgram,
    });

    const signature = await sendTransaction(sellIxs);
    console.log('txid:', signature);
  }
}
