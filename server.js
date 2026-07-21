/* ════════════════════════════════════════════════════════
   CHRONICLE EMPIRE — NFT Airdrop Server v6
   ────────────────────────────────────────────────────────
   Минт переведён на thirdweb SDK v5 (claimTo). Он сам подтягивает
   allowlist-proof владельца для фазы "Only Owner" — то, что голый
   ethers сделать не мог (пустой proof уводил в публичную ветку с
   лимитом 0 → реверт).

   • Минт:           thirdweb v5  (claimTo + THIRDWEB_SECRET_KEY)
   • Чтение/диагноз: ethers v5    (/diagnose, /balances, /health)
   ════════════════════════════════════════════════════════ */

const express = require("express");
const cors    = require("cors");
const ethers  = require("ethers");
require("dotenv").config();

// thirdweb v5
const { createThirdwebClient, getContract, sendTransaction, waitForReceipt, simulateTransaction } = require("thirdweb");
const { privateKeyToAccount } = require("thirdweb/wallets");
const { polygon }             = require("thirdweb/chains");
const { claimTo }             = require("thirdweb/extensions/erc1155");

// Wert NFT Checkout — подпись заказа на бэкенде
const { signSmartContractData } = require("@wert-io/widget-sc-signer");

/* ─────────────── ENV ─────────────── */
const CONTRACT_ADDRESS   = "0xb97909780ADBD66cb4b941B0DFAAb0FA9B4Ba2EB";
const CHAIN_ID           = 137;
const POLYGON_RPC        = process.env.POLYGON_RPC;
const RAW_PK             = process.env.OWNER_PRIVATE_KEY;
const THIRDWEB_SECRET    = process.env.THIRDWEB_SECRET_KEY;
const GAME_URL           = process.env.GAME_URL || "*";

// Разрешённые источники (CORS). GAME_URL можно задать списком через запятую:
//   https://chronicleempire.com,https://www.chronicleempire.com
// "*" (или пустое) — разрешить всем.
const ALLOWED_ORIGINS = GAME_URL.split(",").map(s => s.trim()).filter(Boolean);

if (!POLYGON_RPC)     { console.error("✗ POLYGON_RPC не задан (Alchemy URL, Polygon Mainnet)."); process.exit(1); }
if (!RAW_PK)          { console.error("✗ OWNER_PRIVATE_KEY не задан."); process.exit(1); }
if (!THIRDWEB_SECRET) { console.error("✗ THIRDWEB_SECRET_KEY не задан (нужен для claimTo / proof владельца)."); process.exit(1); }

const OWNER_PRIVATE_KEY = RAW_PK.startsWith("0x") ? RAW_PK : `0x${RAW_PK}`;

/* ─────────────── Wert NFT Checkout ───────────────
   Это ОТДЕЛЬНЫЙ флоу от /mint-boss: тут игрок платит картой через Wert,
   Wert сам вызывает claim() на контракте (msg.sender = кошелёк Wert),
   поэтому для этого нужна ПУБЛИЧНАЯ платная claim-фаза (без allowlist).
   WERT_PRIVATE_KEY — это НЕ блокчейн-ключ, а ключ подписи запроса к Wert API. */
const WERT_PRIVATE_KEY = process.env.WERT_PRIVATE_KEY;               // ключ подписи (sandbox выдаёт Wert)
const WERT_PARTNER_ID  = process.env.WERT_PARTNER_ID;                // Partner ID из Wert Dashboard
const WERT_ORIGIN      = process.env.WERT_ORIGIN  || "https://sandbox.wert.io"; // прод: https://widget.wert.io
const WERT_NETWORK     = process.env.WERT_NETWORK || "amoy";         // прод: "polygon"
const WERT_COMMODITY   = process.env.WERT_COMMODITY || "POL";
const WERT_SC_ADDRESS  = process.env.WERT_SC_ADDRESS;                // адрес контракта В ТОЙ ЖЕ СЕТИ, что WERT_NETWORK

// RPC той сети, где реально исполнится оплата Wert.
// Sandbox → Amoy (публичный RPC по умолчанию, можно переопределить своим).
// Прод     → тот же POLYGON_RPC, что и для остального сервера.
const WERT_RPC_URL = process.env.WERT_RPC_URL
  || (WERT_NETWORK === "polygon" ? POLYGON_RPC : "https://rpc-amoy.polygon.technology");
const WERT_CHAIN_ID = WERT_NETWORK === "polygon" ? 137 : 80002; // Amoy chainId

const WERT_ENABLED = !!(WERT_PRIVATE_KEY && WERT_PARTNER_ID && WERT_SC_ADDRESS);
if (!WERT_ENABLED) {
  console.warn("⚠ Wert checkout выключен: не заданы WERT_PRIVATE_KEY / WERT_PARTNER_ID / WERT_SC_ADDRESS.");
}

// ABI вызова claim() у thirdweb DropERC1155 (ERC1155ClaimConditions)
const CLAIM_ABI = [
  "function claim(address _receiver, uint256 _tokenId, uint256 _quantity, address _currency, uint256 _pricePerToken, tuple(bytes32[] proof, uint256 quantityLimitPerWallet, uint256 pricePerToken, address currency) _allowlistProof, bytes _data) payable",
];
const READ_ABI_WERT = [
  "function getActiveClaimConditionId(uint256 tokenId) view returns (uint256)",
  "function getClaimConditionById(uint256 tokenId, uint256 conditionId) view returns (tuple(uint256 startTimestamp, uint256 maxClaimableSupply, uint256 supplyClaimed, uint256 quantityLimitPerWallet, bytes32 merkleRoot, uint256 pricePerToken, address currency, string metadata) condition)",
];
const claimIface = new ethers.utils.Interface(CLAIM_ABI);
const wertProvider = WERT_ENABLED
  ? new ethers.providers.StaticJsonRpcProvider(WERT_RPC_URL, { chainId: WERT_CHAIN_ID, name: WERT_NETWORK })
  : null;
const wertReadContract = WERT_ENABLED
  ? new ethers.Contract(WERT_SC_ADDRESS, READ_ABI_WERT, wertProvider)
  : null;

const RARITY_TOKEN = { "Common":1, "Uncommon":1, "Rare":2, "Epic":3, "Legendary":4, "Ancient":5 };
const NATIVE_TOKEN = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/* ─────────────── thirdweb (минт) ─────────────── */
const twClient   = createThirdwebClient({ secretKey: THIRDWEB_SECRET });
const ownerAcct  = privateKeyToAccount({ client: twClient, privateKey: OWNER_PRIVATE_KEY });
const twContract = getContract({ client: twClient, chain: polygon, address: CONTRACT_ADDRESS });

/* ─────────────── ethers (чтение/диагноз) ─────────────── */
const READ_ABI = [
  "function balanceOf(address account, uint256 id) view returns (uint256)",
  "function getActiveClaimConditionId(uint256 tokenId) view returns (uint256)",
  "function getClaimConditionById(uint256 tokenId, uint256 conditionId) view returns (tuple(uint256 startTimestamp, uint256 maxClaimableSupply, uint256 supplyClaimed, uint256 quantityLimitPerWallet, bytes32 merkleRoot, uint256 pricePerToken, address currency, string metadata) condition)",
  "function getSupplyClaimedByWallet(uint256 tokenId, uint256 conditionId, address claimer) view returns (uint256)",
  "function nextTokenIdToMint() view returns (uint256)",
];
const provider     = new ethers.providers.StaticJsonRpcProvider(POLYGON_RPC, { chainId: CHAIN_ID, name: "matic" });
const signer       = new ethers.Wallet(OWNER_PRIVATE_KEY, provider);
const readContract = new ethers.Contract(CONTRACT_ADDRESS, READ_ABI, provider);

/* ─────────────── Express ─────────────── */
const app = express();
app.use(express.json());

// CORS: разрешаем либо всем ("*"), либо только источникам из ALLOWED_ORIGINS.
app.use(cors({
  origin: ALLOWED_ORIGINS.includes("*") ? "*" : ALLOWED_ORIGINS,
}));
console.log(`CORS allowed origins: ${ALLOWED_ORIGINS.includes("*") ? "* (все)" : ALLOWED_ORIGINS.join(", ")}`);

/* ─────────────── Анти-чит (in-memory; на free-Render сбрасывается при сне) ─────────────── */
const mintedBosses = new Map();
const hasAlreadyMinted = (a, b) => mintedBosses.has(`${a.toLowerCase()}:${b}`);
const markAsMinted     = (a, b) => mintedBosses.set(`${a.toLowerCase()}:${b}`, true);

/* ─────────────── Ошибки ─────────────── */
function rawErr(err) {
  return (
    err?.reason ||
    err?.shortMessage ||
    err?.info?.error?.message ||
    err?.error?.message ||
    err?.data?.message ||
    err?.message ||
    String(err) ||
    "Unknown error"
  );
}
function hint(message) {
  const m = String(message);
  if (/could not detect network|NETWORK_ERROR|fetch failed/i.test(m))
    return "Проблема с сетью/RPC. Проверь POLYGON_RPC и THIRDWEB_SECRET_KEY.";
  if (/insufficient funds/i.test(m))
    return "На кошельке владельца нет MATIC на газ. Пополни кошелёк-сигнер.";
  if (/!CONDITION|no active|claim condition|DropNoActiveCondition/i.test(m))
    return "Нет активной claim condition для этого tokenId. Настрой claim phase в thirdweb dashboard.";
  if (/proof|allowlist|not in the allowlist|merkle/i.test(m))
    return "Кошелёк-сервер не в allowlist фазы. Для 'Only Owner' минтить должен именно владелец контракта; проверь, что OWNER_PRIVATE_KEY — это владелец.";
  if (/!Qty|ExceedLimit|exceeded|maxClaimable/i.test(m))
    return "Превышен лимит/исчерпан supply фазы. Помни: per-wallet лимит считается на кошелёк-сервер.";
  if (/!Price|!Currency/i.test(m))
    return "price/currency не совпадают с условием. Для бесплатного airdrop в фазе должно быть price=0, currency=native.";
  return "Открой /diagnose/<tokenId> для детальной проверки.";
}

/* ════════════════════════════════════════════════
   POST /mint-boss  — через thirdweb claimTo
   ════════════════════════════════════════════════ */
app.post("/mint-boss", async (req, res) => {
  const { playerAddress, bossId, bossName, rarity } = req.body;

  if (!playerAddress || bossId === undefined || bossId === null || !bossName || !rarity)
    return res.status(400).json({ error: "Missing required fields" });
  if (!ethers.utils.isAddress(playerAddress))
    return res.status(400).json({ error: "Invalid wallet address" });
  if (hasAlreadyMinted(playerAddress, bossId))
    return res.status(409).json({ error: "Boss already minted for this wallet" });

  const tokenId = RARITY_TOKEN[rarity] ?? 1;

  try {
    console.log(`Minting: ${bossName} (${rarity}) tokenId:${tokenId} → ${playerAddress}`);

    // claimTo сам читает активную claim condition и собирает allowlistProof
    // (для "Only Owner" — proof владельца, т.к. отправитель = ownerAcct).
    const transaction = claimTo({
      contract: twContract,
      to:       playerAddress,
      tokenId:  BigInt(tokenId),
      quantity: 1n,
    });

    // PRE-FLIGHT: симуляция от имени владельца — ловим точную причину без газа.
    try {
      await simulateTransaction({ transaction, account: ownerAcct });
    } catch (simErr) {
      const reason = rawErr(simErr);
      console.error(`✗ Simulation reverted: ${reason}`);
      return res.status(400).json({ error: "Claim would revert", reason, hint: hint(reason), tokenId, diagnose: `/diagnose/${tokenId}` });
    }

    const { transactionHash } = await sendTransaction({ transaction, account: ownerAcct });
    console.log(`TX sent: ${transactionHash}`);
    await waitForReceipt({ client: twClient, chain: polygon, transactionHash });
    console.log(`✓ Minted! TX: ${transactionHash}`);

    markAsMinted(playerAddress, bossId);

    return res.json({
      success: true,
      txHash:  transactionHash,
      tokenId,
      bossName,
      rarity,
      opensea: `https://opensea.io/assets/matic/${CONTRACT_ADDRESS}/${tokenId}`,
    });

  } catch (err) {
    const reason = rawErr(err);
    console.error("Mint error:", reason);
    return res.status(500).json({ error: "Mint failed", reason, hint: hint(reason) });
  }
});

/* ════════════════════════════════════════════════
   POST /wert/create-order — подписанные данные для Wert-виджета
   Игрок платит картой → Wert вызывает claim() от своего кошелька,
   поэтому цена/валюта берутся из ПУБЛИЧНОЙ claim-фазы контракта,
   а не из /mint-boss логики (там минтит владелец бесплатно).
   ════════════════════════════════════════════════ */
app.post("/wert/create-order", async (req, res) => {
  if (!WERT_ENABLED)
    return res.status(500).json({ error: "Wert checkout не настроен на сервере (WERT_PRIVATE_KEY/WERT_PARTNER_ID/WERT_SC_ADDRESS)" });

  const { playerAddress, tokenId } = req.body;
  if (!playerAddress || !ethers.utils.isAddress(playerAddress))
    return res.status(400).json({ error: "Invalid wallet address" });

  const tid = parseInt(tokenId, 10);
  if (!Number.isInteger(tid) || tid < 1 || tid > 5)
    return res.status(400).json({ error: "Invalid tokenId (ожидается 1-5)" });

  try {
    // Читаем актуальную ПУБЛИЧНУЮ claim-фазу для tokenId из той же сети,
    // в которой Wert реально отправит транзакцию (amoy в sandbox, polygon в проде).
    const cid = await wertReadContract.getActiveClaimConditionId(tid);
    const c   = await wertReadContract.getClaimConditionById(tid, cid);

    if (c.currency.toLowerCase() !== NATIVE_TOKEN.toLowerCase()) {
      return res.status(400).json({ error: "Сейчас поддержана только оплата в нативной валюте сети (POL). Для ERC20-цены нужна отдельная настройка commodity." });
    }
    if (c.merkleRoot !== ethers.constants.HashZero) {
      return res.status(400).json({ error: "На этой claim-фазе включён allowlist — Wert не сможет её пройти, фаза должна быть публичной." });
    }

    const pricePerToken = c.pricePerToken; // BigNumber, в wei
    const commodityAmount = parseFloat(ethers.utils.formatEther(pricePerToken));

    // Публичный клейм = "пустой" AllowlistProof (см. DropSinglePhase1155.sol)
    const allowlistProof = {
      proof: [],
      quantityLimitPerWallet: 0,
      pricePerToken: ethers.constants.MaxUint256,
      currency: ethers.constants.AddressZero,
    };

    const scInputData = claimIface.encodeFunctionData("claim", [
      playerAddress,
      tid,
      1,
      NATIVE_TOKEN,
      pricePerToken,
      allowlistProof,
      "0x",
    ]);

    const signedData = signSmartContractData(
      {
        address:           playerAddress,
        commodity:         WERT_COMMODITY,
        network:           WERT_NETWORK,
        commodity_amount:  commodityAmount,
        sc_address:        WERT_SC_ADDRESS,
        sc_input_data:     scInputData,
      },
      WERT_PRIVATE_KEY
    );

    return res.json({
      ...signedData,
      partner_id: WERT_PARTNER_ID,
      origin:     WERT_ORIGIN,
      click_id:   `${playerAddress.slice(2, 8)}-${tid}-${Date.now()}`,
    });

  } catch (err) {
    const reason = rawErr(err);
    console.error("Wert order error:", reason);
    return res.status(500).json({ error: "Could not build Wert order", reason, hint: hint(reason) });
  }
});

/* ════════════════════════════════════════════════
   GET /diagnose/:tokenId  (ethers, read-only)
   ════════════════════════════════════════════════ */
app.get("/diagnose/:tokenId", async (req, res) => {
  const tokenId = parseInt(req.params.tokenId, 10);
  const out = { tokenId, checks: {} };

  try { out.checks.network = `OK (block ${await provider.getBlockNumber()})`; }
  catch (e) { out.checks.network = `FAIL — ${rawErr(e)}`; }

  try {
    const bal = await provider.getBalance(signer.address);
    out.signer = signer.address;
    out.signerMatic = ethers.utils.formatEther(bal);
    out.checks.gas = parseFloat(out.signerMatic) > 0.05 ? "OK" : "LOW — пополни MATIC";
  } catch (e) { out.checks.gas = `FAIL — ${rawErr(e)}`; }

  try {
    const next = await readContract.nextTokenIdToMint();
    out.checks.lazyMinted = tokenId < next.toNumber()
      ? `OK (lazy-minted: 0..${next.toNumber() - 1})`
      : `FAIL — tokenId ${tokenId} ещё НЕ lazy-minted (next=${next.toString()})`;
  } catch (e) { out.checks.lazyMinted = `n/a — ${rawErr(e)}`; }

  try {
    const cid = await readContract.getActiveClaimConditionId(tokenId);
    out.activeConditionId = cid.toString();
    const c = await readContract.getClaimConditionById(tokenId, cid);
    out.claimCondition = {
      started:                c.startTimestamp.toNumber() * 1000 <= Date.now(),
      startTimestamp:         new Date(c.startTimestamp.toNumber() * 1000).toISOString(),
      maxClaimableSupply:     c.maxClaimableSupply.toString(),
      supplyClaimed:          c.supplyClaimed.toString(),
      quantityLimitPerWallet: c.quantityLimitPerWallet.toString(),
      pricePerToken:          c.pricePerToken.toString(),
      currency:               c.currency,
      hasAllowlist:           c.merkleRoot !== ethers.constants.HashZero,
      isFree:                 c.pricePerToken.isZero(),
    };
    out.note = out.claimCondition.hasAllowlist
      ? "Фаза с allowlist (напр. 'Only Owner'): минт идёт через thirdweb claimTo, proof владельца собирается автоматически."
      : "Публичная фаза без allowlist.";
    out.verdict = "Условие прочитано. Если минт всё равно падает — смотри reason из /mint-boss.";
  } catch (e) {
    out.activeConditionId = null;
    out.verdict = [`Нет активной claim condition для tokenId ${tokenId}: ${rawErr(e)}`];
  }

  return res.json(out);
});

/* ════════════════════════════════════════════════
   GET /balances/:address
   ════════════════════════════════════════════════ */
app.get("/balances/:address", async (req, res) => {
  try {
    const addr = req.params.address;
    if (!ethers.utils.isAddress(addr)) return res.status(400).json({ error: "Invalid address" });
    const ids  = [0, 1, 2, 3, 4, 5];
    const bals = await Promise.all(ids.map(id => readContract.balanceOf(addr, id)));
    return res.json({
      gold: bals[0].toString(), uncommon: bals[1].toString(), rare: bals[2].toString(),
      epic: bals[3].toString(), legendary: bals[4].toString(), ancient: bals[5].toString(),
    });
  } catch (err) { return res.status(500).json({ error: rawErr(err) }); }
});

/* ════════════════════════════════════════════════
   GET /health
   ════════════════════════════════════════════════ */
app.get("/health", async (req, res) => {
  try {
    const block = await provider.getBlockNumber();
    const bal   = await provider.getBalance(signer.address);
    res.json({ status: "ok", contract: CONTRACT_ADDRESS, signer: signer.address,
               signerMatic: ethers.utils.formatEther(bal), chainId: CHAIN_ID, block, mintEngine: "thirdweb-v5" });
  } catch (err) { res.status(500).json({ status: "degraded", error: rawErr(err) }); }
});

/* ─────────────── Старт ─────────────── */
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Chronicle Empire NFT Server v6 (thirdweb SDK) on port ${PORT}`);
  console.log(`Contract: ${CONTRACT_ADDRESS}`);
  console.log(`Signer:   ${signer.address}`);
  console.log(`Wert checkout: ${WERT_ENABLED ? `ON (${WERT_NETWORK}, sc=${WERT_SC_ADDRESS})` : "OFF"}`);
  try {
    const block = await provider.getBlockNumber();
    const bal   = await provider.getBalance(signer.address);
    console.log(`Network OK — block ${block}, signer balance ${ethers.utils.formatEther(bal)} MATIC`);
    if (parseFloat(ethers.utils.formatEther(bal)) < 0.05)
      console.warn("⚠ Баланс сигнера низкий — может не хватить на газ.");
  } catch (e) { console.error("⚠ Стартовая проверка сети не прошла:", rawErr(e)); }
});
