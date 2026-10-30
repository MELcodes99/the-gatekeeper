// Seeds the vault pot with $WIF from the deployer wallet.
// Usage: npm run seed -- 500000      (amount in whole $WIF)
import "dotenv/config";
import { createPublicClient, createWalletClient, http, parseUnits, erc20Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { robinhood, VAULT_ABI, WIF_ADDRESS } from "../src/chain.mjs";

const amount = parseUnits(process.argv[2] || process.env.SEED_AMOUNT || "0", 18);
if (amount === 0n) throw new Error("Pass an amount: npm run seed -- 500000");

const vault = process.env.VAULT_ADDRESS;
if (!vault) throw new Error("Missing env VAULT_ADDRESS");
const wif = process.env.WIF_ADDRESS || WIF_ADDRESS;

const transport = http(process.env.RPC_URL || robinhood.rpcUrls.default.http[0]);
const account = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY);
const pub = createPublicClient({ chain: robinhood, transport });
const wallet = createWalletClient({ account, chain: robinhood, transport });

const send = async (req) => {
  const hash = await wallet.writeContract(req);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`reverted ${hash}`);
  console.log(req.functionName, hash);
};

await send({ address: wif, abi: erc20Abi, functionName: "approve", args: [vault, amount] });
await send({ address: vault, abi: VAULT_ABI, functionName: "seed", args: [amount] });
console.log("pot is now", (await pub.readContract({ address: vault, abi: VAULT_ABI, functionName: "pot" })).toString());
