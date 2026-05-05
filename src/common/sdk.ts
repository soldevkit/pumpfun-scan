import BN from 'bn.js';
import bs58 from 'bs58';
import { PrivacyCash } from 'privacycash';
import { TwoWayPegClient } from '@zeus-network/zeus-stack-sdk';
import { createJupiterApiClient } from '@jup-ag/api';
import {
  getCurrentPosition,
  getFinalPosition,
  getInitPositionIx,
  getOperateIx,
} from '@jup-ag/lend/borrow';
import { Client as JupiterLendClient } from '@jup-ag/lend-read';
import { SolendActionCore } from '@solendprotocol/solend-sdk';
import {
  OnlinePumpSdk,
  PUMP_SDK,
  getBuyTokenAmountFromSolAmount,
  getSellSolAmountFromTokenAmount,
} from '@pump-fun/pump-sdk';
import {
  getAssociatedTokenAddressSync,
  unpackMint,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
} from '@solana/spl-token';
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  TransactionSignature,
  VersionedTransaction,
  VersionedTransactionResponse,
} from '@solana/web3.js';
import {
  COMPUTE_BUDGET_PROGRAM_ADDRESS,
  MAX_COMPUTE_UNIT_LIMIT,
  tokenAmountToUiAmount,
  tokenUiAmountToAmount,
} from 'gill/programs';

import dotenv from 'dotenv';
dotenv.config();

import { loadKeypair } from './helper';
import { AddressLookupTableAccount } from '@solana/web3.js';
import { SystemProgram } from '@solana/web3.js';
import { getUserLendingPositionByAsset } from '@jup-ag/lend/earn';

const ZERO = new BN(0);
const NATIVE_MINT_ADDRESS = NATIVE_MINT.toBase58();
const RPC_URL = 'https://willie-l4msmu-fast-mainnet.helius-rpc.com';

// RPC connection
const connection = new Connection(RPC_URL, 'confirmed');
const wallet = loadKeypair(process.env.WALLET_KEYPAIR!);

const pumpSdk = new OnlinePumpSdk(connection);
const jupiterApi = createJupiterApiClient({ basePath: 'https://lite-api.jup.ag' });
const jupiterLend = new JupiterLendClient(connection);

export async function getTransactionResponse(
  signature: TransactionSignature,
): Promise<VersionedTransactionResponse> {
  const tx = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0 });

  if (!tx || tx.meta?.err) {
    throw new Error('Transaction failed');
  }

  return tx;
}

export async function getTokenProgramId(mintPubkey: PublicKey): Promise<[PublicKey, number]> {
  const mintInfo = await connection.getAccountInfo(mintPubkey);
  if (!mintInfo) throw new Error('Mint not found');

  const programId = mintInfo.owner;
  const mint = unpackMint(mintPubkey, mintInfo, programId);

  return [programId, mint.decimals];
}

export async function getTokenAmount(mint: string): Promise<BN> {
  if (mint === NATIVE_MINT_ADDRESS) {
    const lamports = await connection.getBalance(wallet.publicKey);
    if (lamports > 0.05e9) {
      return new BN(lamports - 0.05e9);
    } else {
      return ZERO;
    }
  } else {
    const inputMintPubkey = new PublicKey(mint);
    const [tokenProgramId] = await getTokenProgramId(inputMintPubkey);
    const { value: tokenAmount } = await connection.getTokenAccountBalance(
      getAssociatedTokenAddressSync(inputMintPubkey, wallet.publicKey, false, tokenProgramId),
    );
    return new BN(tokenAmount.amount);
  }
}

export async function sendTransaction(
  ixs: TransactionInstruction[],
  addressLookupTableAccounts?: AddressLookupTableAccount[],
): Promise<TransactionSignature> {
  // --- build + send tx ---
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

  const finalIxs: TransactionInstruction[] = [...ixs];

  const computeIxs = [
    ComputeBudgetProgram.setComputeUnitLimit({
      units: MAX_COMPUTE_UNIT_LIMIT,
    }),
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: 50_000, // adjust based on priority needs
    }),
  ];

  const txSim = new VersionedTransaction(
    new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: blockhash,
      instructions: [...computeIxs, ...ixs],
    }).compileToV0Message(addressLookupTableAccounts),
  );
  const { value: sim } = await connection.simulateTransaction(txSim, { sigVerify: false });

  if (sim.unitsConsumed) {
    finalIxs.unshift(
      ComputeBudgetProgram.setComputeUnitLimit({
        units: sim.unitsConsumed * 1.2,
      }),
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: 50_000, // adjust based on priority needs
      }),
    );
  }

  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: blockhash,
      instructions: [...computeIxs, ...ixs],
    }).compileToV0Message(addressLookupTableAccounts),
  );
  tx.sign([wallet]);

  // console.log('Tx:', Buffer.from(tx.serialize()).toString('base64'));

  // send (fast path)
  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 2,
  });

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
  decimals: number = 9,
  slippage: number = 0.05,
) {
  const quoteResponse = await jupiterApi.quoteGet({
    inputMint,
    outputMint,
    amount: amount.toNumber(),
    dynamicSlippage: true,
  });

  console.log('Dynamic slippage bps:', quoteResponse.slippageBps);
  console.log(' Out amount:', tokenAmountToUiAmount(BigInt(quoteResponse.outAmount), decimals));

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
    skipPreflight: false,
    maxRetries: 2,
  });

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

export async function swap(
  inputMint: string,
  outputMint: string,
  amount: number,
  slippage: number = 0.05,
) {
  let decimals: number;
  if (inputMint === NATIVE_MINT_ADDRESS) {
    decimals = 9;
  } else {
    const inputMintPubkey = new PublicKey(inputMint);
    [, decimals] = await getTokenProgramId(inputMintPubkey);
  }

  const inputAmount = new BN(tokenUiAmountToAmount(amount, decimals));

  const signature = await jupiterSwap(inputMint, outputMint, inputAmount, decimals, slippage);
  console.log('Txid:', signature);
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
    lamports = new BN(tokenUiAmountToAmount(solAmount, 9));
  }
  if (lamports.eq(ZERO)) return;

  const mintPubkey = new PublicKey(mint);
  const [tokenProgramId, decimals] = await getTokenProgramId(mintPubkey);

  const [buyState, global, feeConfig] = await Promise.all([
    pumpSdk.fetchBuyState(mintPubkey, wallet.publicKey, tokenProgramId),
    pumpSdk.fetchGlobal(),
    pumpSdk.fetchFeeConfig(),
  ]);

  let signature: TransactionSignature;

  if (buyState.bondingCurve.complete) {
    signature = await jupiterSwap(NATIVE_MINT_ADDRESS, mint, lamports, decimals, slippage);
  } else {
    if (tokenProgramId.equals(TOKEN_PROGRAM_ID)) {
      throw new Error('Deprecated Bonding Curve');
    }

    const expectedTokens = getBuyTokenAmountFromSolAmount({
      global,
      feeConfig,
      mintSupply: buyState.bondingCurve.tokenTotalSupply,
      bondingCurve: buyState.bondingCurve,
      amount: lamports,
    });
    const realSolReserves = BigInt(buyState.bondingCurve.realSolReserves.toString());
    const virtualSolReserves = BigInt(buyState.bondingCurve.virtualSolReserves.toString());
    console.log('    Real MC:', tokenAmountToUiAmount(realSolReserves, 9));
    console.log(' Virtual MC:', tokenAmountToUiAmount(virtualSolReserves, 9));
    console.log(' Out amount:', tokenAmountToUiAmount(BigInt(expectedTokens.toString()), decimals));

    const buyIxs = await PUMP_SDK.buyInstructions({
      global,
      ...buyState,
      mint: mintPubkey,
      user: wallet.publicKey,
      amount: expectedTokens,
      solAmount: lamports,
      slippage,
      tokenProgram: tokenProgramId,
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
  const mintPubkey = new PublicKey(mint);
  const [tokenProgramId, decimals] = await getTokenProgramId(mintPubkey);

  let amount: BN;
  if (tokenAmount === undefined) {
    amount = await getTokenAmount(mint);
  } else {
    amount = new BN(tokenUiAmountToAmount(tokenAmount, decimals));
  }
  if (amount.eq(ZERO)) return;

  const [sellState, global, feeConfig] = await Promise.all([
    pumpSdk.fetchSellState(mintPubkey, wallet.publicKey, tokenProgramId),
    pumpSdk.fetchGlobal(),
    pumpSdk.fetchFeeConfig(),
  ]);

  let signature: TransactionSignature;

  if (sellState.bondingCurve.complete) {
    signature = await jupiterSwap(mint, NATIVE_MINT_ADDRESS, amount, 9, slippage);
  } else {
    const expectedLamports = getSellSolAmountFromTokenAmount({
      global,
      feeConfig,
      mintSupply: sellState.bondingCurve.tokenTotalSupply,
      bondingCurve: sellState.bondingCurve,
      amount,
    });
    const realSolReserves = BigInt(sellState.bondingCurve.realSolReserves.toString());
    const virtualSolReserves = BigInt(sellState.bondingCurve.virtualSolReserves.toString());
    console.log('    Real MC:', tokenAmountToUiAmount(realSolReserves, 9));
    console.log(' Virtual MC:', tokenAmountToUiAmount(virtualSolReserves, 9));
    console.log(' Out amount:', tokenAmountToUiAmount(BigInt(expectedLamports.toString()), 9));

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
      tokenProgram: tokenProgramId,
    });

    signature = await sendTransaction(sellIxs);
  }

  const tx = await getTransactionResponse(signature);
  const preBalance = tx.meta?.preBalances[0] || 0;
  const postBalance = tx.meta?.postBalances[0] || 0;
  console.log('Real amount:', tokenAmountToUiAmount(BigInt(postBalance - preBalance), 9));

  console.log('\nTxid:', signature);
}

export async function depositPrivacyPool(amount: number, mint: string = NATIVE_MINT_ADDRESS) {
  const privacy = new PrivacyCash({ RPC_url: RPC_URL, owner: bs58.encode(wallet.secretKey) });

  if (mint === NATIVE_MINT_ADDRESS) {
    const depAmount = tokenUiAmountToAmount(amount, 9);
    if (depAmount > Number.MAX_SAFE_INTEGER) throw new Error('Invalid withdrawal amount');

    // Transaction Fee ~ 0.003 SOL or 3e6 lamports
    const { tx } = await privacy.deposit({
      lamports: Number(depAmount.toString()),
    });
    console.log('Txid:', tx);

    const { lamports } = await privacy.getPrivateBalance();
    console.log('Private balance:', tokenAmountToUiAmount(BigInt(lamports), 9));
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
  const privacy = new PrivacyCash({ RPC_url: RPC_URL, owner: bs58.encode(wallet.secretKey) });

  if (mint === NATIVE_MINT_ADDRESS) {
    const widAmount = tokenUiAmountToAmount(amount, 9);
    if (widAmount > Number.MAX_SAFE_INTEGER) throw new Error('Invalid withdrawal amount');

    const { tx } = await privacy.withdraw({
      lamports: Number(widAmount.toString()),
      recipientAddress: recipient,
    });
    console.log('Txid:', tx);

    const { lamports } = await privacy.getPrivateBalance();
    console.log('Private balance:', tokenAmountToUiAmount(BigInt(lamports), 9));
    console.log('\n');
  } else {
    throw new Error('SPL deposit is not supported');
  }
}

export async function solendBorrow(market: string) {
  // SolendActionCore.initialize()
  // SolendActionCore.buildDepositTxns()
  // await LendingInstruction.DepositObligationCollateral
}

export async function jupiterBorrow(vaultId: number, colAmount: number, debtAmount: number) {
  const vault = await jupiterLend.vault.getVaultByVaultId(vaultId);
  console.log('Loaded vault:', vault.vault.toBase58());

  // const metadata = await jupiterLend.vault.getVaultMetadata({ vaultId });
  // console.log(metadata?.supplyMintDecimals, metadata?.borrowMintDecimals);

  const { nftId: positionId } = await getInitPositionIx({
    vaultId,
    connection,
    signer: wallet.publicKey,
  });
  console.log('Position #:', positionId);

  const preIxs: TransactionInstruction[] = [];
  const postIxs: TransactionInstruction[] = [];

  let supplyDecimals: number, borrowDecimals: number;
  if (vault.constantViews.supplyToken.equals(NATIVE_MINT)) {
    supplyDecimals = 9;

    const supplyAta = getAssociatedTokenAddressSync(NATIVE_MINT, wallet.publicKey);
    preIxs.push(
      createAssociatedTokenAccountIdempotentInstruction(
        wallet.publicKey,
        supplyAta,
        wallet.publicKey,
        NATIVE_MINT,
      ),
    );
    if (colAmount > 0) {
      preIxs.push(
        SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: supplyAta,
          lamports: BigInt(
            new BN(tokenUiAmountToAmount(colAmount, supplyDecimals)).addn(1).toString(),
          ),
        }),
        createSyncNativeInstruction(supplyAta),
      );
    }
    postIxs.push(createCloseAccountInstruction(supplyAta, wallet.publicKey, wallet.publicKey));
  } else {
    [, supplyDecimals] = await getTokenProgramId(vault.constantViews.supplyToken);
  }

  if (vault.constantViews.borrowToken.equals(NATIVE_MINT)) {
    borrowDecimals = 9;

    const supplyAta = getAssociatedTokenAddressSync(NATIVE_MINT, wallet.publicKey);
    preIxs.push(
      createAssociatedTokenAccountIdempotentInstruction(
        wallet.publicKey,
        supplyAta,
        wallet.publicKey,
        NATIVE_MINT,
      ),
    );
    // TODO: test
    postIxs.push(createCloseAccountInstruction(supplyAta, wallet.publicKey, wallet.publicKey));
  } else {
    [, borrowDecimals] = await getTokenProgramId(vault.constantViews.borrowToken);
  }

  const { ixs, addressLookupTableAccounts } = await getOperateIx({
    vaultId,
    positionId: 425,
    colAmount: new BN(tokenUiAmountToAmount(colAmount, supplyDecimals)),
    debtAmount: new BN(tokenUiAmountToAmount(debtAmount, borrowDecimals)),
    signer: wallet.publicKey,
    connection,
  });

  const signature = await sendTransaction(
    [...preIxs, ...ixs, ...postIxs],
    addressLookupTableAccounts,
  );
  console.log('Txid:', signature);
}
