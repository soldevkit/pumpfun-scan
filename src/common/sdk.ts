import BN from 'bn.js';
import bs58 from 'bs58';
import { PrivacyCash } from 'privacycash';
import { createJupiterApiClient } from '@jup-ag/api';
import { SolendActionCore } from '@solendprotocol/solend-sdk';
import {
  OnlinePumpSdk,
  PUMP_SDK,
  getBuyTokenAmountFromSolAmount,
  getSellSolAmountFromTokenAmount,
} from '@pump-fun/pump-sdk';
import { getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  ComputeBudgetProgram,
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  TransactionSignature,
  VersionedTransaction,
  VersionedTransactionResponse,
} from '@solana/web3.js';

import dotenv from 'dotenv';
dotenv.config();

import { loadKeypair } from './helper';

const ZERO = new BN(0);
const NATIVE_MINT_ADDRESS = NATIVE_MINT.toBase58();
const RPC_URL = 'https://willie-l4msmu-fast-mainnet.helius-rpc.com';

// RPC connection
const connection = new Connection(RPC_URL, 'confirmed');
const wallet = loadKeypair(process.env.WALLET_KEYPAIR!);

const privacy = new PrivacyCash({ RPC_url: RPC_URL, owner: bs58.encode(wallet.secretKey) });
const pumpSdk = new OnlinePumpSdk(connection);
const jupiterApi = createJupiterApiClient({ basePath: 'https://lite-api.jup.ag' });

export async function getTransactionResponse(
  signature: TransactionSignature,
): Promise<VersionedTransactionResponse> {
  const tx = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0 });

  if (!tx || tx.meta?.err) {
    throw new Error('Transaction failed');
  }

  return tx;
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

async function jupiterSwap(
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
  const dps = outputMint === NATIVE_MINT_ADDRESS ? LAMPORTS_PER_SOL : 1e6; // TODO
  console.log(' Out amount:', Number(quoteResponse.outAmount) / dps);

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

  let signature: TransactionSignature;

  if (buyState.bondingCurve.complete) {
    signature = await jupiterSwap(NATIVE_MINT_ADDRESS, mint, lamports, slippage);
  } else {
    if (tokenProgram.equals(TOKEN_PROGRAM_ID)) {
      throw new Error('Deprecated Bonding Curve');
    }

    const expectedTokens = getBuyTokenAmountFromSolAmount({
      global,
      feeConfig,
      mintSupply: buyState.bondingCurve.tokenTotalSupply,
      bondingCurve: buyState.bondingCurve,
      amount: lamports,
    });
    const realSolReserves = buyState.bondingCurve.realSolReserves;
    const virtualSolReserves = buyState.bondingCurve.virtualSolReserves;

    console.log('    Real MC:', realSolReserves.toNumber() / LAMPORTS_PER_SOL);
    console.log(' Virtual MC:', virtualSolReserves.toNumber() / LAMPORTS_PER_SOL);
    console.log(' Out amount:', expectedTokens.toNumber() / 1e6);

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

    signature = await sendTransaction(buyIxs);
  }

  const tx = await getTransactionResponse(signature);
  const preBalances = tx.meta?.preTokenBalances || [];
  const postBalances = tx.meta?.postTokenBalances || [];
  const preBalance =
    preBalances.find((b) => b.mint === mint && b.owner === wallet.publicKey.toBase58())
      ?.uiTokenAmount.uiAmount || 0;
  const postBalance =
    postBalances.find((b) => b.mint === mint && b.owner === wallet.publicKey.toBase58())
      ?.uiTokenAmount.uiAmount || 0;
  console.log('Real amount:', postBalance - preBalance);

  console.log('\nTxid:', signature);
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

  let signature: TransactionSignature;

  if (sellState.bondingCurve.complete) {
    signature = await jupiterSwap(mint, NATIVE_MINT_ADDRESS, amount, slippage);
  } else {
    const expectedLamports = getSellSolAmountFromTokenAmount({
      global,
      feeConfig,
      mintSupply: sellState.bondingCurve.tokenTotalSupply,
      bondingCurve: sellState.bondingCurve,
      amount,
    });
    const realSolReserves = sellState.bondingCurve.realSolReserves;
    const virtualSolReserves = sellState.bondingCurve.virtualSolReserves;
    console.log('    Real MC:', realSolReserves.toNumber() / LAMPORTS_PER_SOL);
    console.log(' Virtual MC:', virtualSolReserves.toNumber() / LAMPORTS_PER_SOL);
    console.log(' Out amount:', expectedLamports.toNumber() / LAMPORTS_PER_SOL);

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

    signature = await sendTransaction(sellIxs);
  }

  const tx = await getTransactionResponse(signature);
  const preBalance = tx.meta?.preBalances[0] || 0;
  const postBalance = tx.meta?.postBalances[0] || 0;
  console.log('Real amount:', (postBalance - preBalance) / LAMPORTS_PER_SOL);

  console.log('\nTxid:', signature);
}

export async function depositPrivacyPool(amount: number, mint: string = NATIVE_MINT_ADDRESS) {
  if (mint === NATIVE_MINT_ADDRESS) {
    const { tx } = await privacy.deposit({
      lamports: Math.floor(amount * LAMPORTS_PER_SOL),
    });
    console.log('Txid:', tx);

    const { lamports } = await privacy.getPrivateBalance();
    console.log('Private balance:', lamports / LAMPORTS_PER_SOL);
    console.log('\n');
  } else {
    throw new Error('SPL deposit is not supported');
  }
}

export async function withdrawPrivacyPool(
  recipient: string,
  amount: number,
  mint: string = NATIVE_MINT_ADDRESS,
) {
  if (mint === NATIVE_MINT_ADDRESS) {
    const { tx } = await privacy.withdraw({
      lamports: Math.floor(amount * LAMPORTS_PER_SOL),
      recipientAddress: recipient,
    });
    console.log('Txid:', tx);

    const { lamports } = await privacy.getPrivateBalance();
    console.log('Private balance:', lamports / LAMPORTS_PER_SOL);
    console.log('\n');
  } else {
    throw new Error('SPL deposit is not supported');
  }
}

export async function fetchSolendPools(market: string) {
  // SolendActionCore.buildDepositObligationCollateralTxns()
  // await LendingInstruction.DepositObligationCollateral
}
