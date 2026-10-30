// Deploys GatekeeperVault to Robinhood Chain.
// Usage: npm run deploy   (reads .env)
import "dotenv/config";
import { createPublicClient, createWalletClient, http, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { robinhood, vaultArtifact, WIF_ADDRESS } from "../src/chain.mjs";

const need = (k) => {
  if (!process.env[k]) throw new Error(`Missing env ${k}`);
  return process.env[k];
};

const RPC_URL = process.env.RPC_URL || robinhood.rpcUrls.default.http[0];
const deployer = privateKeyToAccount(need("DEPLOYER_PRIVATE_KEY"));
const gatekeeper =
  process.env.GATEKEEPER_ADDRESS || privateKeyToAccount(need("GATEKEEPER_PRIVATE_KEY")).address;
const wifToken = process.env.WIF_ADDRESS || WIF_ADDRESS;

const W = (n) => parseUnits(String(n), 18);
const args = [
  wifToken,
  gatekeeper,
  W(process.env.BASE_FEE || 1000), // first attempt of a round costs 1,000 $WIF
  BigInt(process.env.FEE_STEP_BPS || 100), // +1% per attempt in the round
  W(process.env.MAX_FEE || 10000), // capped at 10,000 $WIF
  BigInt(process.env.BURN_BPS || 3000), // 30% of each refused fee burns, 70% grows the pot
  BigInt(process.env.WINNER_BPS || 8000), // winner takes 80%, 20% seeds next round
  BigInt(process.env.TIMEOUT || 3600), // refund if not ruled within an hour
];

const transport = http(RPC_URL);
const pub = createPublicClient({ chain: robinhood, transport });
const wallet = createWalletClient({ account: deployer, chain: robinhood, transport });

console.log("deployer  ", deployer.address);
console.log("gatekeeper", gatekeeper);
console.log("wif       ", wifToken);

const hash = await wallet.deployContract({ abi: vaultArtifact.abi, bytecode: vaultArtifact.bytecode, args });
console.log("tx        ", hash);
const r = await pub.waitForTransactionReceipt({ hash });
if (r.status !== "success") throw new Error("deploy reverted");

console.log("\nVAULT_ADDRESS=" + r.contractAddress);
console.log("START_BLOCK=" + r.blockNumber);
console.log(`\n${robinhood.blockExplorers.default.url}/address/${r.contractAddress}`);
