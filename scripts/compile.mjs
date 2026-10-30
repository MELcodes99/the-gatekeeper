// Compiles contracts/ with solc-js and writes ABIs + bytecode to artifacts/.
import fs from "node:fs";
import path from "node:path";
import solc from "solc";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const files = ["contracts/GatekeeperVault.sol", "contracts/mocks/MockTokens.sol"];

const sources = Object.fromEntries(
  files.map((f) => [f, { content: fs.readFileSync(path.join(root, f), "utf8") }])
);

const input = {
  language: "Solidity",
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: "shanghai",
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
  },
};

const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (out.errors || []).filter((e) => e.severity === "error");
for (const e of out.errors || []) console.error(e.formattedMessage);
if (errors.length) process.exit(1);

fs.mkdirSync(path.join(root, "artifacts"), { recursive: true });
for (const file of Object.keys(out.contracts)) {
  for (const [name, c] of Object.entries(out.contracts[file])) {
    fs.writeFileSync(
      path.join(root, "artifacts", `${name}.json`),
      JSON.stringify({ abi: c.abi, bytecode: "0x" + c.evm.bytecode.object }, null, 2)
    );
    console.log("compiled", name);
  }
}
