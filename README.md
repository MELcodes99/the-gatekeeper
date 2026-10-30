# The Gatekeeper

An AI guards a vault of $WIF on Robinhood Chain. Its only job is to refuse you.

Every attempt to talk your way in is paid in $WIF, written on-chain, and answered in public. Refused fees are split: 30% burns forever, 70% grows the vault. Convince the Gatekeeper to open and you take 80% of everything inside. The other 20% seeds the next round.

Built for the World is Flat hackathon. The idea is the token's own: finance has always had gatekeepers who decide who gets in. Here you can argue with one.

## Why it keeps people coming back

- **The pot only grows.** Every refusal adds 70% of the fee to the vault, so each failed attempt makes the next one more tempting.
- **The price rises with the crowd.** Each attempt in a round costs 1% more than the last, which speeds up pot growth.
- **Every refusal is content.** Messages and replies live on-chain and on the public wall, made to be screenshotted and shared.
- **Every attempt burns $WIF.** Usage permanently reduces supply.
- **Rounds never end.** A win leaves 20% behind, so the next round starts with something to fight for.

## How it works

1. The player approves $WIF and calls `attempt(message, maxFeeAccepted)`. The fee is held in escrow and the message is emitted on-chain.
2. The agent reads the event, gives the message to the LLM along with recent attempts from the round, and the model must call either `refuse` or `open_gate`.
3. The agent posts `rule(id, open, reply)`. The reply is emitted on-chain next to the message.
4. Refused: 30% of the fee burns (via the token's `burn()`, or the dead address as a fallback), 70% joins the pot. Opened: the winner receives 80% of pot plus their fee, 20% carries over, round increments.

### Trust guarantees in the contract

- The owner **cannot withdraw the pot**. There is no withdraw function.
- The gatekeeper key can **only** rule on pending attempts.
- If the gatekeeper does not answer within the timeout (1 hour), **anyone can trigger a full refund** to the player.
- The timeout can only be lowered, never raised.
- `maxFeeAccepted` protects players from fee changes between signing and inclusion.
- Only an attempt from the current round can win the current pot.
- Fees are measured by balance delta, so the accounting holds even for fee-on-transfer tokens.

## Contracts

| | Address |
|---|---|
| $WIF (World is Flat) | `0x5173b8eA6923c2d40267890D45C46a3480954773` |
| GatekeeperVault | `0x0F389c721cdDD57Fa347049C97E8347249105df4` |
| Chain | Robinhood Chain, ID 4663 |

## Run it

```bash
npm install
npm test                 # compiles and runs the contract test suite
cp .env.example .env     # fill in keys
npm run deploy           # prints VAULT_ADDRESS and START_BLOCK, paste them into .env
npm run seed -- 100000   # put $WIF in the vault
npm start                # agent + site on http://localhost:3000
```

Local test with no LLM: set `JUDGE_MOCK=1` and the agent refuses everything without calling the model.

### Deploy to Render

Web service, Node. Build command `npm run build`, start command `npm start`. Add the variables from `.env` (except `DEPLOYER_PRIVATE_KEY`, which the server never needs).

## Layout

## Disclaimer

Not affiliated with, endorsed by, or connected to Robinhood Markets, Inc. $WIF is a memecoin with no promise of value or return. Burned $WIF cannot be recovered.
