/* ════════════════════════════════════════════════════════
   CHRONICLE EMPIRE — NFT Airdrop Server
   Node.js + Express + ethers.js
   
   Деплой: Railway.app (бесплатно)
   ════════════════════════════════════════════════════════ */

const express = require("express");
const cors    = require("cors");
const ethers  = require("ethers");
require("dotenv").config();

const app  = express();
app.use(express.json());
app.use(cors({ origin: process.env.GAME_URL || "*" }));

// ── Config ─────────────────────────────────────────────
const CONTRACT_ADDRESS = "0xb97909780ADBD66cb4b941B0DFAAb0FA9B4Ba2EB";
const POLYGON_RPC      = "https://polygon-rpc.com";
const CHAIN_ID         = 137;

// Token IDs (порядок минта в thirdweb)
const TOKEN_IDS = {
  GOLD:      0,
  UNCOMMON:  1,
  RARE:      2,
  EPIC:      3,
  LEGENDARY: 4,
  ANCIENT:   5,
};

const RARITY_TOKEN = {
  "Common":    TOKEN_IDS.UNCOMMON,
  "Uncommon":  TOKEN_IDS.UNCOMMON,
  "Rare":      TOKEN_IDS.RARE,
  "Epic":      TOKEN_IDS.EPIC,
  "Legendary": TOKEN_IDS.LEGENDARY,
  "Ancient":   TOKEN_IDS.ANCIENT,
};

// ERC-1155 ABI (только нужные методы)
const ABI = [
  "function mintTo(address to, uint256 tokenId, string uri, uint256 amount) external",
  "function balanceOf(address account, uint256 id) view returns (uint256)",
];

// ── Provider & Signer ───────────────────────────────────
const provider = new ethers.providers.JsonRpcProvider(POLYGON_RPC);
const signer   = new ethers.Wallet(process.env.OWNER_PRIVATE_KEY, provider);
const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, signer);

// ── Anti-cheat: track minted bosses per player ──────────
// В продакшене заменить на базу данных (MongoDB/PostgreSQL)
const mintedBosses = new Map(); // "playerAddress:bossId" → true

function getMintKey(playerAddress, bossId) {
  return `${playerAddress.toLowerCase()}:${bossId}`;
}

function hasAlreadyMinted(playerAddress, bossId) {
  return mintedBosses.has(getMintKey(playerAddress, bossId));
}

function markAsMinted(playerAddress, bossId) {
  mintedBosses.set(getMintKey(playerAddress, bossId), true);
}

// ══════════════════════════════════════════════════════
//  POST /mint-boss
//  Игра вызывает это после победы над боссом
//  Body: { playerAddress, bossId, bossName, rarity }
// ══════════════════════════════════════════════════════
app.post("/mint-boss", async (req, res) => {
  const { playerAddress, bossId, bossName, rarity } = req.body;

  // Валидация
  if (!playerAddress || !bossId || !bossName || !rarity) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  if (!ethers.utils.isAddress(playerAddress)) {
    return res.status(400).json({ error: "Invalid wallet address" });
  }

  // Anti-cheat: каждый босс минтится только 1 раз на кошелёк
  if (hasAlreadyMinted(playerAddress, bossId)) {
    return res.status(409).json({ error: "Boss already minted for this wallet" });
  }

  const tokenId = RARITY_TOKEN[rarity] ?? TOKEN_IDS.UNCOMMON;

  try {
    console.log(`Minting: ${bossName} (${rarity}) → ${playerAddress}`);

    // Airdrop NFT напрямую на кошелёк игрока
    const tx = await contract.mintTo(
      playerAddress,
      tokenId,
      "", // URI берётся из контракта
      1   // количество
    );

    console.log(`TX sent: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`TX confirmed: ${receipt.transactionHash}`);

    // Записываем что босс заминчен
    markAsMinted(playerAddress, bossId);

    return res.json({
      success: true,
      txHash:  receipt.transactionHash,
      tokenId,
      bossName,
      rarity,
      opensea: `https://opensea.io/assets/matic/${CONTRACT_ADDRESS}/${tokenId}`,
    });

  } catch (err) {
    console.error("Mint error:", err);
    return res.status(500).json({
      error:   "Mint failed",
      details: err.message,
    });
  }
});

// ══════════════════════════════════════════════════════
//  POST /mint-gold
//  Минт Gold после оплаты через NFT Checkout
//  Body: { playerAddress, amount, paymentTxHash }
// ══════════════════════════════════════════════════════
app.post("/mint-gold", async (req, res) => {
  const { playerAddress, amount, paymentTxHash } = req.body;

  if (!playerAddress || !amount || !paymentTxHash) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  if (!ethers.utils.isAddress(playerAddress)) {
    return res.status(400).json({ error: "Invalid wallet address" });
  }

  // TODO: Verify paymentTxHash on-chain before minting
  // This prevents minting Gold without real payment

  try {
    const tx = await contract.mintTo(
      playerAddress,
      TOKEN_IDS.GOLD,
      "",
      amount
    );

    const receipt = await tx.wait();

    return res.json({
      success: true,
      txHash:  receipt.transactionHash,
      amount,
    });

  } catch (err) {
    console.error("Gold mint error:", err);
    return res.status(500).json({ error: "Mint failed", details: err.message });
  }
});

// ══════════════════════════════════════════════════════
//  GET /balances/:address
//  Получить все NFT балансы игрока
// ══════════════════════════════════════════════════════
app.get("/balances/:address", async (req, res) => {
  const { address } = req.params;

  if (!ethers.utils.isAddress(address)) {
    return res.status(400).json({ error: "Invalid address" });
  }

  try {
    const tokenIds  = Object.values(TOKEN_IDS);
    const addresses = tokenIds.map(() => address);
    const balances  = await Promise.all(
      tokenIds.map(id => contract.balanceOf(address, id))
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

// ── Health check ────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", contract: CONTRACT_ADDRESS, network: "Polygon" });
});

// ── Start ───────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Chronicle Empire NFT Server running on port ${PORT}`);
  console.log(`Contract: ${CONTRACT_ADDRESS}`);
  console.log(`Signer:   ${signer.address}`);
});
