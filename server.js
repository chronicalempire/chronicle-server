/* ════════════════════════════════════════════════════════
   CHRONICLE EMPIRE — NFT Airdrop Server
   Uses thirdweb SDK for correct contract interaction
   ════════════════════════════════════════════════════════ */

const express  = require("express");
const cors     = require("cors");
const { createThirdwebClient, getContract, sendTransaction } = require("thirdweb");
const { polygon } = require("thirdweb/chains");
const { privateKeyToAccount } = require("thirdweb/wallets");
const { mintTo, balanceOf } = require("thirdweb/extensions/erc1155");
require("dotenv").config();

const app = express();
app.use(express.json());
app.use(cors({ origin: process.env.GAME_URL || "*" }));

// ── Config ─────────────────────────────────────────────
const CONTRACT_ADDRESS = "0xb97909780ADBD66cb4b941B0DFAAb0FA9B4Ba2EB";

const TOKEN_IDS = {
  GOLD:      0n,
  UNCOMMON:  1n,
  RARE:      2n,
  EPIC:      3n,
  LEGENDARY: 4n,
  ANCIENT:   5n,
};

const RARITY_TOKEN = {
  "Common":    1n,
  "Uncommon":  1n,
  "Rare":      2n,
  "Epic":      3n,
  "Legendary": 4n,
  "Ancient":   5n,
};

// ── thirdweb client ────────────────────────────────────
const client = createThirdwebClient({
  secretKey: process.env.THIRDWEB_SECRET_KEY || "",
});

const account = privateKeyToAccount({
  client,
  privateKey: `0x${process.env.OWNER_PRIVATE_KEY}`,
});

const contract = getContract({
  client,
  chain: polygon,
  address: CONTRACT_ADDRESS,
});

// ── Anti-cheat ─────────────────────────────────────────
const mintedBosses = new Map();

function hasAlreadyMinted(playerAddress, bossId) {
  return mintedBosses.has(`${playerAddress.toLowerCase()}:${bossId}`);
}

function markAsMinted(playerAddress, bossId) {
  mintedBosses.set(`${playerAddress.toLowerCase()}:${bossId}`, true);
}

// ══════════════════════════════════════════════════════
//  POST /mint-boss
// ══════════════════════════════════════════════════════
app.post("/mint-boss", async (req, res) => {
  const { playerAddress, bossId, bossName, rarity } = req.body;

  if (!playerAddress || !bossId || !bossName || !rarity) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  if (hasAlreadyMinted(playerAddress, bossId)) {
    return res.status(409).json({ error: "Boss already minted for this wallet" });
  }

  const tokenId = RARITY_TOKEN[rarity] ?? 1n;

  try {
    console.log(`Minting: ${bossName} (${rarity}) tokenId:${tokenId} → ${playerAddress}`);

    const transaction = mintTo({
      contract,
      to: playerAddress,
      tokenId,
      supply: 1n,
    });

    const receipt = await sendTransaction({ transaction, account });
    console.log(`✓ Minted! TX: ${receipt.transactionHash}`);

    markAsMinted(playerAddress, bossId);

    return res.json({
      success: true,
      txHash:  receipt.transactionHash,
      tokenId: tokenId.toString(),
      bossName,
      rarity,
      opensea: `https://opensea.io/assets/matic/${CONTRACT_ADDRESS}/${tokenId}`,
    });

  } catch (err) {
    console.error("Mint error:", err.message);
    return res.status(500).json({ error: "Mint failed", details: err.message });
  }
});

// ══════════════════════════════════════════════════════
//  GET /balances/:address
// ══════════════════════════════════════════════════════
app.get("/balances/:address", async (req, res) => {
  try {
    const addr = req.params.address;
    const ids  = Object.values(TOKEN_IDS);

    const balances = await Promise.all(
      ids.map(id => balanceOf({ contract, owner: addr, tokenId: id }))
    );

    return res.json({
      gold:      balances[0].toString(),
      uncommon:  balances[1].toString(),
      rare:      balances[2].toString(),
      epic:      balances[3].toString(),
      legendary: balances[4].toString(),
      ancient:   balances[5].toString(),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── Health ──────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", contract: CONTRACT_ADDRESS });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Chronicle Empire NFT Server on port ${PORT}`);
  console.log(`Contract: ${CONTRACT_ADDRESS}`);
  console.log(`Account:  ${account.address}`);
});
