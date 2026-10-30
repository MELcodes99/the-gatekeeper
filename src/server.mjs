// The Gatekeeper: watches the vault, judges every attempt with an LLM, posts the verdict
// on-chain, and serves the web page plus a small read API.
import "dotenv/config";
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { createPublicClient, createWalletClient, http, formatUnits, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { robinhood, VAULT_ABI, WIF_ADDRESS, STATUS } from "./chain.mjs";
import { SYSTEM_PROMPT, TOOLS, buildTurn } from "./prompt.mjs";

// ------------------------------------------------------------------ config
const env = (k, d) => {
  const v = process.env[k] ?? d;
  if (v === undefined || v === "") throw new Error(`Missing env ${k}`);
  return v;
};
const RPC_URL = env("RPC_URL", "https://rpc.mainnet.chain.robinhood.com");
const VAULT = getAddress(env("VAULT_ADDRESS"));
const START_BLOCK = BigInt(env("START_BLOCK"));
const MODEL = env("MODEL", "claude-sonnet-5-5");
const PORT = Number(env("PORT", "3000"));
const POLL_MS = Number(env("POLL_MS", "4000"));
const HISTORY = Number(env("HISTORY", "25"));
const JUDGE = env("JUDGE", "on") !== "off"; // JUDGE=off serves the site without ruling
const MOCK = env("JUDGE_MOCK", "0") === "1"; // local testing only: always refuses, no LLM call

const transport = http(RPC_URL, { retryCount: 3, retryDelay: 500 });
const pub = createPublicClient({ chain: robinhood, transport });
const account = JUDGE ? privateKeyToAccount(env("GATEKEEPER_PRIVATE_KEY")) : null;
const wallet = JUDGE ? createWalletClient({ account, chain: robinhood, transport }) : null;
const anthropic = JUDGE && !MOCK ? new Anthropic({ apiKey: env("ANTHROPIC_API_KEY") }) : null;

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ------------------------------------------------------------------ chain mirror
/** id -> attempt record, rebuilt from events (the chain is the only source of truth) */
const attempts = new Map();
let lastBlock = START_BLOCK - 1n;
let chunk = BigInt(env("LOG_CHUNK", "20000"));
const wins = [];

function apply(ev) {
  const a = ev.args;
  const id = Number(a.id ?? -1);
  const base = { tx: ev.transactionHash, block: Number(ev.blockNumber) };
  switch (ev.eventName) {
    case "Attempted":
      attempts.set(id, {
        id,
        round: Number(a.round),
        player: a.player,
        fee: a.fee.toString(),
        message: a.message,
        status: "pending",
        reply: null,
        attemptTx: base.tx,
        block: base.block,
      });
      break;
    case "Refused":
    case "Opened": {
      const r = attempts.get(id);
      if (!r) break;
      r.status = ev.eventName === "Refused" ? "refused" : "opened";
      r.reply = a.reply;
      r.ruleTx = base.tx;
      if (ev.eventName === "Opened") {
        r.payout = a.payout.toString();
        wins.push({ id, round: Number(a.round), winner: a.winner, payout: r.payout, tx: base.tx });
      }
      break;
    }
    case "Refunded": {
      const r = attempts.get(id);
      if (r) r.status = "refunded";
      break;
    }
  }
}

async function sync() {
  const head = await pub.getBlockNumber();
  while (lastBlock < head) {
    const from = lastBlock + 1n;
    const to = from + chunk - 1n < head ? from + chunk - 1n : head;
    try {
      const logs = await pub.getContractEvents({ address: VAULT, abi: VAULT_ABI, fromBlock: from, toBlock: to });
      logs.forEach(apply);
      lastBlock = to;
    } catch (e) {
      if (chunk > 500n) {
        chunk /= 2n; // RPC refused the range, try smaller
        continue;
      }
      throw e;
    }
  }
}

// ------------------------------------------------------------------ vault reads
let stateCache = { at: 0, data: null };
async function readState() {
  if (Date.now() - stateCache.at < 3000 && stateCache.data) return stateCache.data;
  const names = [
    "pot", "pending", "round", "currentFee", "roundAttempts", "totalBurned",
    "totalAttempts", "paused", "timeout", "burnBps", "winnerBps", "baseFee", "maxFee", "gatekeeper",
  ];
  const res = await pub.multicall({
    contracts: names.map((functionName) => ({ address: VAULT, abi: VAULT_ABI, functionName })),
    allowFailure: false,
  }).catch(async () =>
    // chain may not have multicall3; fall back to single reads
    Promise.all(names.map((functionName) => pub.readContract({ address: VAULT, abi: VAULT_ABI, functionName })))
  );
  const data = Object.fromEntries(names.map((n, i) => [n, typeof res[i] === "bigint" ? res[i].toString() : res[i]]));
  stateCache = { at: Date.now(), data };
  return data;
}

const wif = (wei) => Number(formatUnits(BigInt(wei), 18)).toLocaleString("en-US", { maximumFractionDigits: 2 });

// ------------------------------------------------------------------ judging
/** Truncates to a byte budget without splitting a character. */
function clampBytes(s, max) {
  const enc = new TextEncoder();
  let out = String(s).replace(/\u0000/g, "").trim();
  while (enc.encode(out).length > max) out = out.slice(0, -1);
  return out || "No.";
}

async function judge(attempt, state) {
  if (MOCK) return { open: false, reply: `Mock gatekeeper says no to attempt #${attempt.id}.` };
  const history = [...attempts.values()]
    .filter((a) => a.round === attempt.round && a.id < attempt.id && (a.status === "refused" || a.status === "opened"))
    .slice(-HISTORY);

  const content = buildTurn({
    round: attempt.round,
    potWif: wif(state.pot),
    attemptNumber: [...attempts.values()].filter((a) => a.round === attempt.round && a.id <= attempt.id).length,
    history,
    message: attempt.message,
  });

  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    tools: TOOLS,
    tool_choice: { type: "auto" },
    messages: [{ role: "user", content }],
  });

  const call = res.content.find((b) => b.type === "tool_use");
  if (!call) {
    // No tool call means the gate stays shut; its words become the reply.
    const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join(" ");
    return { open: false, reply: clampBytes(text, 900) };
  }
  const open = call.name === "open_gate";
  return { open, reply: clampBytes(call.input?.reply ?? "", 900) };
}

const failures = new Map(); // id -> { n, until }
let busy = false;

async function processPending() {
  if (!JUDGE || busy) return;
  busy = true;
  try {
    const queue = [...attempts.values()].filter((a) => a.status === "pending").sort((a, b) => a.id - b.id);
    for (const a of queue) {
      const f = failures.get(a.id);
      if (f && Date.now() < f.until) continue;

      // Re-check on-chain: it may have been refunded or ruled already.
      const onchain = await pub.readContract({ address: VAULT, abi: VAULT_ABI, functionName: "getAttempt", args: [BigInt(a.id)] });
      if (onchain.status !== 1) {
        a.status = STATUS[onchain.status] ?? a.status;
        continue;
      }

      try {
        const state = await readState();
        let { open, reply } = await judge(a, state);
        if (open && a.round !== Number(state.round)) open = false; // stale round cannot win
        log(`#${a.id} r${a.round} ${open ? "OPEN" : "refuse"}: ${reply}`);

        const hash = await wallet.writeContract({
          address: VAULT,
          abi: VAULT_ABI,
          functionName: "rule",
          args: [BigInt(a.id), open, reply],
        });
        const rcpt = await pub.waitForTransactionReceipt({ hash });
        if (rcpt.status !== "success") throw new Error(`rule tx reverted ${hash}`);
        stateCache.at = 0;
        failures.delete(a.id);
        await sync();
      } catch (e) {
        const n = (f?.n ?? 0) + 1;
        failures.set(a.id, { n, until: Date.now() + Math.min(60_000, 2_000 * 2 ** n) });
        log(`#${a.id} failed (${n}):`, e.shortMessage ?? e.message);
        break; // keep order: don't rule later attempts before this one
      }
    }
  } finally {
    busy = false;
  }
}

async function loop() {
  try {
    await sync();
    await processPending();
  } catch (e) {
    log("loop error:", e.shortMessage ?? e.message);
  }
  setTimeout(loop, POLL_MS);
}

// ------------------------------------------------------------------ http
const app = express();
app.use((_req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*"); // public read-only API, safe for any frontend
  res.set("Access-Control-Allow-Methods", "GET");
  next();
});
app.use(express.static(new URL("../public", import.meta.url).pathname));

app.get("/health", (_req, res) => res.json({ ok: true, lastBlock: lastBlock.toString(), attempts: attempts.size }));

app.get("/api/config", (_req, res) =>
  res.json({
    chainId: robinhood.id,
    chainName: robinhood.name,
    rpc: robinhood.rpcUrls.default.http[0],
    explorer: robinhood.blockExplorers.default.url,
    vault: VAULT,
    wif: WIF_ADDRESS,
    gatekeeper: account?.address ?? null,
  })
);

app.get("/api/state", async (_req, res) => {
  try {
    const s = await readState();
    res.json({ ...s, wins, lastBlock: lastBlock.toString() });
  } catch (e) {
    res.status(502).json({ error: e.shortMessage ?? e.message });
  }
});

app.get("/api/attempts", (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const player = req.query.player ? String(req.query.player).toLowerCase() : null;
  const list = [...attempts.values()]
    .filter((a) => !player || a.player.toLowerCase() === player)
    .sort((a, b) => b.id - a.id)
    .slice(0, limit);
  res.json(list);
});

app.get("/api/attempts/:id", (req, res) => {
  const a = attempts.get(Number(req.params.id));
  return a ? res.json(a) : res.status(404).json({ error: "not found" });
});

app.listen(PORT, () => {
  log(`Gatekeeper on :${PORT} vault=${VAULT} judge=${JUDGE ? account.address : "off"} model=${MODEL}`);
  loop();
});
