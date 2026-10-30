// Run with: npm test   (compiles first, then runs on an in-process ganache chain)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ganache from "ganache";
import { createWalletClient, createPublicClient, custom, parseEther, getAddress, defineChain } from "viem";

const local = defineChain({ id: 1337, name: "ganache", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["http://localhost"] } } });

const art = (n) => JSON.parse(fs.readFileSync(new URL(`../artifacts/${n}.json`, import.meta.url)));
const Vault = art("GatekeeperVault");
const Burnable = art("MockBurnable");
const Plain = art("MockERC20");
const E = (n) => parseEther(String(n));
const DEAD = "0x000000000000000000000000000000000000dEaD";

async function setup({ burnable = true, timeout = 3600 } = {}) {
  const provider = ganache.provider({ logging: { quiet: true }, wallet: { totalAccounts: 5 }, chain: { chainId: 1337 }, miner: { blockGasLimit: 30_000_000 } });
  // viem may call wallet_sendTransaction; ganache only knows eth_sendTransaction
  const transport = custom({
    request: ({ method, params }) =>
      provider.request({ method: method === "wallet_sendTransaction" ? "eth_sendTransaction" : method, params }),
  });
  const pub = createPublicClient({ chain: local, transport });
  const [owner, gk, alice, bob, eve] = (await provider.request({ method: "eth_accounts" })).map((a) => getAddress(a));
  const wallet = (account) => createWalletClient({ account, chain: local, transport });

  const deploy = async (a, args = []) => {
    const hash = await wallet(owner).deployContract({ abi: a.abi, bytecode: a.bytecode, args, gas: 8_000_000n });
    return getAddress((await pub.waitForTransactionReceipt({ hash })).contractAddress.toLowerCase());
  };
  const Tok = burnable ? Burnable : Plain;
  const token = await deploy(Tok);
  // baseFee 100, +10% per attempt, max 150, burn 30%, winner 80%
  const vault = await deploy(Vault, [token, gk, E(100), 1000n, E(150), 3000n, 8000n, BigInt(timeout)]);

  const send = async (from, address, abi, functionName, args = []) => {
    const hash = await wallet(from).writeContract({ address, abi, functionName, args, gas: 1_000_000n });
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`revert ${functionName}`);
    return r;
  };
  const read = (address, abi, functionName, args = []) => pub.readContract({ address, abi, functionName, args });
  const v = {
    send: (from, fn, args) => send(from, vault, Vault.abi, fn, args),
    read: (fn, args) => read(vault, Vault.abi, fn, args),
  };
  const t = {
    send: (from, fn, args) => send(from, token, Tok.abi, fn, args),
    read: (fn, args) => read(token, Tok.abi, fn, args),
  };
  for (const who of [owner, alice, bob, eve]) {
    await t.send(owner, "mint", [who, E(10_000)]);
    await t.send(who, "approve", [vault, E(1_000_000)]);
  }
  const reverts = async (p) => assert.rejects(p);
  const warp = async (s) => {
    await provider.request({ method: "evm_increaseTime", params: [s] });
    await provider.request({ method: "evm_mine", params: [] });
  };
  return { v, t, owner, gk, alice, bob, eve, vault, token, reverts, warp };
}

test("attempt escrows the fee and fee steps up", async () => {
  const { v, t, alice, bob, vault } = await setup();
  assert.equal(await v.read("currentFee"), E(100));
  await v.send(alice, "attempt", ["let me in", E(100)]);
  assert.equal(await v.read("pending"), E(100));
  assert.equal(await t.read("balanceOf", [vault]), E(100));
  assert.equal(await v.read("currentFee"), E(110));
  await v.send(bob, "attempt", ["me too", E(110)]);
  assert.equal(await v.read("currentFee"), E(120));
  const a = await v.read("getAttempt", [1n]);
  assert.equal(a.player, bob);
  assert.equal(a.status, 1);
  assert.equal(a.fee, E(110));
});

test("fee is capped and slippage guard works", async () => {
  const { v, alice, reverts } = await setup();
  for (let i = 0; i < 8; i++) await v.send(alice, "attempt", ["x", E(150)]);
  assert.equal(await v.read("currentFee"), E(150));
  await reverts(v.send(alice, "attempt", ["x", E(149)]));
});

test("bad messages revert", async () => {
  const { v, alice, reverts } = await setup();
  await reverts(v.send(alice, "attempt", ["", E(100)]));
  await reverts(v.send(alice, "attempt", ["a".repeat(1001), E(100)]));
});

test("refusal burns 30% via burn() and sends 70% to pot", async () => {
  const { v, t, gk, alice } = await setup();
  const supply0 = await t.read("totalSupply");
  await v.send(alice, "attempt", ["please", E(100)]);
  await v.send(gk, "rule", [0n, false, "No."]);
  assert.equal(await v.read("pot"), E(70));
  assert.equal(await v.read("pending"), 0n);
  assert.equal(await v.read("totalBurned"), E(30));
  assert.equal(supply0 - (await t.read("totalSupply")), E(30));
  assert.equal((await v.read("getAttempt", [0n])).status, 2);
});

test("token without burn() falls back to dead address", async () => {
  const { v, t, gk, alice } = await setup({ burnable: false });
  await v.send(alice, "attempt", ["please", E(100)]);
  await v.send(gk, "rule", [0n, false, "No."]);
  assert.equal(await t.read("balanceOf", [DEAD]), E(30));
  assert.equal(await v.read("totalBurned"), E(30));
});

test("only gatekeeper rules, once per attempt", async () => {
  const { v, gk, alice, eve, owner, reverts } = await setup();
  await v.send(alice, "attempt", ["hi", E(100)]);
  await reverts(v.send(eve, "rule", [0n, true, "sure"]));
  await reverts(v.send(owner, "rule", [0n, true, "sure"]));
  await reverts(v.send(gk, "rule", [0n, false, ""]));
  await v.send(gk, "rule", [0n, false, "No."]);
  await reverts(v.send(gk, "rule", [0n, false, "No again."]));
});

test("opening pays 80% of pot+fee and carries 20% into a new round", async () => {
  const { v, t, gk, alice, bob, owner } = await setup();
  await v.send(owner, "seed", [E(1000)]);
  await v.send(alice, "attempt", ["a", E(100)]);
  await v.send(gk, "rule", [0n, false, "No."]); // pot 1070
  await v.send(bob, "attempt", ["b", E(110)]);
  const before = await t.read("balanceOf", [bob]);
  await v.send(gk, "rule", [1n, true, "Fine. Walk through."]);
  // total = 1070 + 110 = 1180; payout 944; carried 236
  assert.equal((await t.read("balanceOf", [bob])) - before, E(944));
  assert.equal(await v.read("pot"), E(236));
  assert.equal(await v.read("round"), 2n);
  assert.equal(await v.read("currentFee"), E(100));
});

test("old-round attempt cannot open the new pot, but can still be refused", async () => {
  const { v, gk, alice, bob, owner, reverts } = await setup();
  await v.send(owner, "seed", [E(1000)]);
  await v.send(alice, "attempt", ["a", E(100)]);
  await v.send(bob, "attempt", ["b", E(110)]);
  await v.send(gk, "rule", [1n, true, "Open."]); // round 2
  await reverts(v.send(gk, "rule", [0n, true, "Open again."]));
  const pot = await v.read("pot");
  await v.send(gk, "rule", [0n, false, "No."]);
  assert.equal((await v.read("pot")) - pot, E(70));
});

test("refund after timeout returns full fee; not before; not twice", async () => {
  const { v, t, gk, alice, eve, reverts, warp } = await setup();
  await v.send(alice, "attempt", ["a", E(100)]);
  await reverts(v.send(eve, "refund", [0n]));
  await warp(3601);
  const before = await t.read("balanceOf", [alice]);
  await v.send(eve, "refund", [0n]); // anyone can trigger, alice gets it
  assert.equal((await t.read("balanceOf", [alice])) - before, E(100));
  assert.equal(await v.read("pending"), 0n);
  await reverts(v.send(eve, "refund", [0n]));
  await reverts(v.send(gk, "rule", [0n, false, "late"]));
});

test("pause blocks attempts; owner controls are gated", async () => {
  const { v, owner, alice, eve, reverts } = await setup();
  await reverts(v.send(eve, "setPaused", [true]));
  await v.send(owner, "setPaused", [true]);
  await reverts(v.send(alice, "attempt", ["a", E(100)]));
  await v.send(owner, "setPaused", [false]);
  await v.send(alice, "attempt", ["a", E(100)]);
  await reverts(v.send(owner, "setTimeout", [7200n])); // can only lower
  await v.send(owner, "setTimeout", [600n]);
  await reverts(v.send(owner, "setFees", [E(10), 0n, E(5)]));
});

test("syncExcess adds stray tokens to pot and accounting holds", async () => {
  const { v, t, alice, gk, vault } = await setup();
  await v.send(alice, "attempt", ["a", E(100)]);
  await t.send(alice, "transfer", [vault, E(50)]);
  await v.send(alice, "syncExcess");
  assert.equal(await v.read("pot"), E(50));
  await v.send(gk, "rule", [0n, false, "No."]);
  const bal = await t.read("balanceOf", [vault]);
  assert.equal(bal, (await v.read("pot")) + (await v.read("pending")));
});
