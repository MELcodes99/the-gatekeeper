import fs from "node:fs";
import { defineChain } from "viem";

export const robinhood = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  blockExplorers: { default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" } },
});

// $WIF (World is Flat) on Robinhood Chain, 18 decimals
export const WIF_ADDRESS = process.env.WIF_ADDRESS || "0x5173b8eA6923c2d40267890D45C46a3480954773";

export const vaultArtifact = JSON.parse(
  fs.readFileSync(new URL("../artifacts/GatekeeperVault.json", import.meta.url))
);
export const VAULT_ABI = vaultArtifact.abi;

export const STATUS = { 1: "pending", 2: "refused", 3: "opened", 4: "refunded" };
