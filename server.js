/* ════════════════════════════════════════════════════════
   CHRONICLE EMPIRE — NFT Airdrop Server v5
   ────────────────────────────────────────────────────────
   Что нового по сравнению с v4:
   • StaticJsonRpcProvider + явная сеть (137/matic) — убивает
     ошибку "could not detect network" окончательно.
   • Pre-flight симуляция claim() через callStatic — узнаём
     ТОЧНУЮ причину реверта ДО отправки транзакции (без газа).
   • Человекочитаемые ошибки + подсказки (claim conditions и т.д.)
   • Проверка env-переменных и баланса MATIC при старте.
   • Эндпоинт /diagnose/:tokenId — читает claim conditions прямо
     из контракта и говорит, что не так.
   ════════════════════════════════════════════════════════ */

const express = require("express");
const cors    = require("cors");
const ethers  = require("ethers");
require("dotenv").config();

/* ─────────────── ENV / конфигурация ─────────────── */
const CONTRACT_ADDRESS = "0xb97909780ADBD66cb4b941B0DFAAb0FA9B4Ba2EB";
const CHAIN_ID         = 137;          // Polygon Mainnet
const POLYGON_RPC      = process.env.POLYGON_RPC;
const RAW_PK           = process.env.OWNER_PRIVATE_KEY;
const GAME_URL         = process.env.GAME_URL || "*";

// Жёсткая проверка обязательных переменных — падаем сразу с понятной ошибкой,
// а не где-то посреди запроса.
if (!POLYGON_RPC) {
  console.error("✗ POLYGON_RPC не задан. Укажи Alchemy URL в Render → Environment.");
  process.exit(1);
}
if (!RAW_PK) {
  console.error("✗ OWNER_PRIVATE_KEY не задан в Render → Environment.");
  process.exit(1);
}
// Принимаем приватный ключ и с '0x', и без — частая причина падения на старте.
const OWNER_PRIVATE_KEY = RAW_PK.startsWith("0x") ? RAW_PK : `0x${RAW_PK}`;

const RARITY_TOKEN = {
  "Common":    1,
  "Uncommon":  1,
  "Rare":      2,
  "Epic":      3,
  "Legendary": 4,
  "Ancient":   5,
};

const NATIVE_TOKEN = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/* ─────────────── ABI ─────────────── */
// thirdweb DropERC1155 (Edition Drop) — claim + read-методы для диагностики.
const ABI = [
  "function claim(address receiver, uint256 tokenId, uint256 quantity, address currency, uint256 pricePerToken, tuple(bytes32[] proof, uint256 quantityLimitPerWallet, uint256 pricePerToken, address currency) allowlistProof, bytes data) external payable",
  "function balanceOf(address account, uint256 id) view returns (uint256)",
  "function getActiveClaimConditionId(uint256 tokenId) view returns (uint256)",
  "function getClaimConditionById(uint256 tokenId, uint256 conditionId) view returns (tuple(uint256 startTimestamp, uint256 maxClaimableSupply, uint256 supplyClaimed, uint256 quantityLimitPerWallet, bytes32 merkleRoot, uint256 pricePerToken, address currency, string metadata) condition)",
  "function getSupplyClaimedByWallet(uint256 tokenId, uint256 conditionId, address claimer) view returns (uint256)",
  "function nextTokenIdToMint() view returns (uint256)",
];

/* ─────────────── Provider / Signer / Contract ───────────────
   StaticJsonRpcProvider + второй аргумент-сеть = ethers НЕ делает
   авто-detect (тот самый eth_chainId, что падал с "could not detect
   network"). Сеть фиксированная, так что это и быстрее, и надёжнее. */
const provider = new ethers.providers.StaticJsonRpcProvider(POLYGON_RPC, {
  chainId: CHAIN_ID,
  name:    "matic",
});
const signer   = new ethers.Wallet(OWNER_PRIVATE_KEY, provider);
const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, signer);

/* ─────────────── Express ─────────────── */
const app = express();
app.use(express.json());
app.use(cors({ origin: GAME_URL }));

/* ─────────────── Анти-чит (in-memory) ───────────────
   ВНИМАНИЕ: Render бесплатный тариф усыпляет/перезапускает инстанс,
   и этот Map обнуляется. Для прод-защиты от повторного минта лучше
   опираться на on-chain balanceOf или внешнюю БД. Сейчас оставлено
   как было, но осознанно. */
const mintedBosses = new Map();
const hasAlreadyMinted = (addr, bossId) => mintedBosses.has(`${addr.toLowerCase()}:${bossId}`);
const markAsMinted     = (addr, bossId) => mintedBosses.set(`${addr.toLowerCase()}:${bossId}`, true);

/* ─────────────── Разбор ошибок ─────────────── */
function rawErr(err) {
  return (
    err?.errorName ||
    err?.reason ||
    err?.error?.reason ||
    err?.error?.error?.message ||  // вложенная ошибка RPC-узла
    err?.error?.message ||
    err?.data?.message ||
    err?.shortMessage ||
    err?.message ||
    "Unknown error"
  );
}

// Превращаем технический реверт thirdweb в человеческую подсказку.
function hint(message) {
  const m = String(message);
  if (/could not detect network|NETWORK_ERROR|SERVER_ERROR/i.test(m))
    return "Проблема с RPC. Проверь POLYGON_RPC (Alchemy URL для Polygon Mainnet).";
  if (/insufficient funds/i.test(m))
    return "На кошельке владельца нет MATIC на газ. Пополни кошелёк-сигнер.";
  if (/!CONDITION|DropNoActiveCondition|no active|claim condition/i.test(m))
    return "Для этого tokenId НЕ настроены/неактивны claim conditions. В thirdweb dashboard задай claim phase для каждого tokenId (1–5), price=0, currency=native, start в прошлом.";
  if (/!Qty|ExceedLimit|exceeded|maxClaimable|!MaxSupply/i.test(m))
    return "Превышен лимит. Важно: per-wallet лимит считается на КОШЕЛЁК-СИГНЕР (он минтит за всех), а не на игрока. Поставь quantityLimitPerWallet = unlimited и проверь общий supply.";
  if (/!Price|!Currency|!PriceOrCurrency/i.test(m))
    return "price/currency не совпадают с claim condition. Для бесплатного airdrop в условии должно быть price=0 и currency=native (MATIC).";
  if (/!Tokens|exceeds|lazy|nextTokenId|URIEmpty/i.test(m))
    return "tokenId ещё не lazy-minted в контракте. Сначала загрузи метаданные (Lazy Mint) для этого tokenId.";
  return "Открой /diagnose/<tokenId> для детальной проверки claim conditions.";
}

/* ════════════════════════════════════════════════
   POST /mint-boss
   ════════════════════════════════════════════════ */
app.post("/mint-boss", async (req, res) => {
  const { playerAddress, bossId, bossName, rarity } = req.body;

  if (!playerAddress || bossId === undefined || bossId === null || !bossName || !rarity) {
    return res.status(400).json({ error: "Missing required fields" });
  }
  if (!ethers.utils.isAddress(playerAddress)) {
    return res.status(400).json({ error: "Invalid wallet address" });
  }
  if (hasAlreadyMinted(playerAddress, bossId)) {
    return res.status(409).json({ error: "Boss already minted for this wallet" });
  }

  const tokenId = RARITY_TOKEN[rarity] ?? 1;

  const allowlistProof = {
    proof: [],
    quantityLimitPerWallet: ethers.constants.MaxUint256,
    pricePerToken:          ethers.constants.MaxUint256, // sentinel: «бери цену из claim condition»
    currency:               ZERO_ADDRESS,
  };

  const claimArgs = [
    playerAddress, // receiver
    tokenId,       // tokenId
    1,             // quantity
    NATIVE_TOKEN,  // currency
    0,             // pricePerToken
    allowlistProof,
    "0x",          // data
  ];

  try {
    console.log(`Minting: ${bossName} (${rarity}) tokenId:${tokenId} → ${playerAddress}`);

    // 1) PRE-FLIGHT: симулируем без отправки. Если контракт ревертит —
    //    узнаём точную причину здесь, не тратя газ и не вешая запрос.
    try {
      await contract.callStatic.claim(...claimArgs, { from: signer.address });
    } catch (simErr) {
      const reason = rawErr(simErr);
      console.error(`✗ Simulation reverted: ${reason}`);
      return res.status(400).json({
        error:   "Claim would revert",
        reason,
        hint:    hint(reason),
        tokenId,
        diagnose: `/diagnose/${tokenId}`,
      });
    }

    // 2) Реальная транзакция (оценим газ, fallback на 500k).
    let gasLimit;
    try {
      const est = await contract.estimateGas.claim(...claimArgs);
      gasLimit  = est.mul(120).div(100); // +20% запас
    } catch {
      gasLimit = ethers.BigNumber.from(500000);
    }

    const tx = await contract.claim(...claimArgs, { gasLimit });
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
    const reason = rawErr(err);
    console.error("Mint error:", reason);
    return res.status(500).json({ error: "Mint failed", reason, hint: hint(reason) });
  }
});

/* ════════════════════════════════════════════════
   GET /diagnose/:tokenId  — читает claim conditions
   ════════════════════════════════════════════════ */
app.get("/diagnose/:tokenId", async (req, res) => {
  const tokenId = parseInt(req.params.tokenId, 10);
  const out = { tokenId, checks: {} };

  try {
    out.checks.network = `OK (block ${await provider.getBlockNumber()})`;
  } catch (e) { out.checks.network = `FAIL — ${rawErr(e)}`; }

  try {
    const bal = await provider.getBalance(signer.address);
    out.signer = signer.address;
    out.signerMatic = ethers.utils.formatEther(bal);
    out.checks.gas = parseFloat(out.signerMatic) > 0.05 ? "OK" : "LOW — пополни MATIC для газа";
  } catch (e) { out.checks.gas = `FAIL — ${rawErr(e)}`; }

  try {
    const next = await contract.nextTokenIdToMint();
    out.checks.lazyMinted = tokenId < next.toNumber()
      ? `OK (lazy-minted: 0..${next.toNumber() - 1})`
      : `FAIL — tokenId ${tokenId} ещё НЕ lazy-minted (next=${next.toString()})`;
  } catch (e) { out.checks.lazyMinted = `n/a — ${rawErr(e)}`; }

  try {
    const cid = await contract.getActiveClaimConditionId(tokenId);
    out.activeConditionId = cid.toString();

    const c = await contract.getClaimConditionById(tokenId, cid);
    const priceWei = c.pricePerToken;
    out.claimCondition = {
      startTimestamp:         new Date(c.startTimestamp.toNumber() * 1000).toISOString(),
      started:                c.startTimestamp.toNumber() * 1000 <= Date.now(),
      maxClaimableSupply:     c.maxClaimableSupply.toString(),
      supplyClaimed:          c.supplyClaimed.toString(),
      quantityLimitPerWallet: c.quantityLimitPerWallet.toString(),
      pricePerToken:          priceWei.toString(),
      currency:               c.currency,
      isFree:                 priceWei.isZero(),
      isNativeCurrency:       c.currency.toLowerCase() === NATIVE_TOKEN.toLowerCase()
                              || c.currency === ZERO_ADDRESS,
    };

    const claimedByOwner = await contract.getSupplyClaimedByWallet(tokenId, cid, signer.address);
    out.claimedByThisServerWallet = claimedByOwner.toString();

    // Вердикт
    const cc = out.claimCondition;
    const problems = [];
    if (!cc.started)          problems.push("claim phase ещё не началась (startTimestamp в будущем)");
    if (!cc.isFree)           problems.push("цена не нулевая — airdrop должен быть price=0");
    if (!cc.isNativeCurrency) problems.push("currency не native — сервер шлёт native, будет !Currency");
    const max = c.maxClaimableSupply;
    if (!max.isZero() && c.supplyClaimed.gte(max)) problems.push("общий supply исчерпан");
    const perWallet = c.quantityLimitPerWallet;
    if (!perWallet.eq(ethers.constants.MaxUint256) && claimedByOwner.gte(perWallet))
      problems.push("per-wallet лимит сигнера исчерпан (он минтит за всех — поставь unlimited)");

    out.verdict = problems.length ? problems : "✓ Условия выглядят корректно для бесплатного airdrop";
  } catch (e) {
    out.activeConditionId = null;
    out.verdict = [`Нет активной claim condition для tokenId ${tokenId}: ${rawErr(e)}`,
                   "Настрой claim phase в thirdweb dashboard для этого tokenId."];
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
    return res.status(500).json({ error: rawErr(err) });
  }
});

/* ════════════════════════════════════════════════
   GET /health
   ════════════════════════════════════════════════ */
app.get("/health", async (req, res) => {
  try {
    const block = await provider.getBlockNumber();
    const bal   = await provider.getBalance(signer.address);
    res.json({
      status:      "ok",
      contract:    CONTRACT_ADDRESS,
      signer:      signer.address,
      signerMatic: ethers.utils.formatEther(bal),
      chainId:     CHAIN_ID,
      block,
    });
  } catch (err) {
    res.status(500).json({ status: "degraded", error: rawErr(err) });
  }
});

/* ─────────────── Старт ─────────────── */
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Chronicle Empire NFT Server v5 on port ${PORT}`);
  console.log(`Contract: ${CONTRACT_ADDRESS}`);
  console.log(`Signer:   ${signer.address}`);
  // Лёгкая само-проверка на старте (не блокирует запуск).
  try {
    const block = await provider.getBlockNumber();
    const bal   = await provider.getBalance(signer.address);
    console.log(`Network OK — block ${block}, signer balance ${ethers.utils.formatEther(bal)} MATIC`);
    if (parseFloat(ethers.utils.formatEther(bal)) < 0.05)
      console.warn("⚠ Баланс сигнера низкий — может не хватить на газ.");
  } catch (e) {
    console.error("⚠ Стартовая проверка сети не прошла:", rawErr(e));
  }
});
