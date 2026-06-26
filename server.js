/* ════════════════════════════════════════════════════════
   CHRONICLE EMPIRE — NFT Airdrop Server v4
   ════════════════════════════════════════════════════════ */

const express = require("express");
const cors    = require("cors");
const ethers  = require("ethers");
require("dotenv").config();

const app = express();
app.use(express.json());
app.use(cors({ origin: process.env.GAME_URL || "*" }));

const CONTRACT_ADDRESS = "0xb97909780ADBD66cb4b941B0DFAAb0FA9B4Ba2EB";
const POLYGON_RPC      = "https://polygon-mainnet.g.alchemy.com/v2/demo";

const RARITY_TOKEN = {
  "Common":    1,
  "Uncommon":  1,
  "Rare":      2,
  "Epic":      3,
  "Legendary": 4,
  "Ancient":   5,
};

// thirdweb ERC-1155 Drop ABI
const ABI = [
  "function claim(address receiver, uint256 tokenId, uint256 quantity, address currency, uint256 pricePerToken, tuple(bytes32[] proof, uint256 quantityLimitPerWallet, uint256 pricePerToken, address currency) allowlistProof, bytes data) external payable",
  "function balanceOf(address account, uint256 id) view returns (uint256)",
];

const provider = new ethers.providers.JsonRpcProvider(POLYGON_RPC);
const signer   = new ethers.Wallet(`0x${process.env.OWNER_PRIVATE_KEY}`, provider);
const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, signer);

const NATIVE_TOKEN = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// Anti-cheat
const mintedBosses = new Map();
function hasAlreadyMinted(addr, bossId) { return mintedBosses.has(`${addr.toLowerCase()}:${bossId}`); }
function markAsMinted(addr, bossId) { mintedBosses.set(`${addr.toLowerCase()}:${bossId}`, true); }

app.post("/mint-boss", async (req, res) => {
  const { playerAddress, bossId, bossName, rarity } = req.body;

  if (!playerAddress || !bossId || !bossName || !rarity) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  if (!ethers.utils.isAddress(playerAddress)) {
    return res.status(400).json({ error: "Invalid wallet address" });
  }

  if (hasAlreadyMinted(playerAddress, bossId)) {
    return res.status(409).json({ error: "Boss already minted for this wallet" });
  }

  const tokenId = RARITY_TOKEN[rarity] ?? 1;

  try {
    console.log(`Minting: ${bossName} (${rarity}) tokenId:${tokenId} → ${playerAddress}`);

    const allowlistProof = {
      proof: [],
      quantityLimitPerWallet: ethers.constants.MaxUint256,
      pricePerToken: ethers.constants.MaxUint256,
      currency: ZERO_ADDRESS,
    };

    const tx = await contract.claim(
      playerAddress,        // receiver
      tokenId,              // tokenId
      1,                    // quantity
      NATIVE_TOKEN,         // currency
      0,                    // pricePerToken
      allowlistProof,       // allowlistProof
      "0x",                 // data
      { gasLimit: 500000 }
    );

    console.log(`TX sent: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`✓ Minted! TX: ${receipt.transactionHash}`);

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
    console.error("Mint error:", err.message);
    return res.status(500).json({ error: "Mint failed", details: err.message });
  }
});

app.get("/balances/:address", async (req, res) => {
  try {
    const addr = req.params.address;
    const ids  = [0, 1, 2, 3, 4, 5];
    const bals = await Promise.all(ids.map(id => contract.balanceOf(addr, id)));
    return res.json({
      gold:      bals[0].toString(),
      uncommon:  bals[1].toString(),
      rare:      bals[2].toString(),
      epic:      bals[3].toString(),
      legendary: bals[4].toString(),
      ancient:   bals[5].toString(),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", contract: CONTRACT_ADDRESS });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Chronicle Empire NFT Server on port ${PORT}`);
  console.log(`Contract: ${CONTRACT_ADDRESS}`);
  console.log(`Signer:   ${signer.address}`);
});
