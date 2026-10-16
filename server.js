require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const {
  exchangeNpssoForCode,
  exchangeCodeForAccessToken,
  getUserPlayedGames,
  getUserTitles,
  getUserTrophyProfileSummary,
  getAccountDevices,
  getTitleTrophies,
  getUserTrophiesEarnedForTitle,
} = require("psn-api");

const app = express();
const PORT = 3000;
const DATA_PATH = path.join(__dirname, "psn_full_data.json");

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// Cache auth token in memory briefly so clicking multiple game modals is fast
let cachedAuth = null;
let authExpiresAt = 0;

async function getAuth() {
  if (cachedAuth && Date.now() < authExpiresAt) {
    return cachedAuth;
  }
  const npsso = process.env.PSN_NPSSO;
  if (!npsso) throw new Error("Missing PSN_NPSSO in .env file");
  const accessCode = await exchangeNpssoForCode(npsso);
  cachedAuth = await exchangeCodeForAccessToken(accessCode);
  authExpiresAt = Date.now() + 45 * 60 * 1000; // 45 mins cache
  return cachedAuth;
}

function parseDuration(durationStr) {
  if (!durationStr) return { hours: 0, readable: "0h 0m", seconds: 0 };
  const h = parseInt(durationStr.match(/(\d+)H/)?.[1] || "0", 10);
  const m = parseInt(durationStr.match(/(\d+)M/)?.[1] || "0", 10);
  const s = parseInt(durationStr.match(/(\d+)S/)?.[1] || "0", 10);
  const totalSeconds = h * 3600 + m * 60 + s;
  return {
    hours: +(totalSeconds / 3600).toFixed(1),
    readable: `${h}h ${m}m`,
    seconds: totalSeconds,
  };
}

function normalizeName(name = "") {
  return name
    .toLowerCase()
    .replace(/trophies$/i, "")
    .replace(/[™®©]/g, "")
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

async function fetchAllPlayedGames(auth) {
  let allGames = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const res = await getUserPlayedGames(auth, "me", { limit, offset });
    if (!res.titles || res.titles.length === 0) break;
    allGames.push(...res.titles);
    if (res.titles.length < limit) break;
    offset += limit;
  }
  return allGames;
}

async function fetchAllTrophyTitles(auth) {
  let allTrophies = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const res = await getUserTitles(auth, "me", { limit, offset });
    if (!res.trophyTitles || res.trophyTitles.length === 0) break;
    allTrophies.push(...res.trophyTitles);
    if (allTrophies.length >= res.totalItemCount || res.trophyTitles.length < limit) break;
    offset += limit;
  }
  return allTrophies;
}

async function syncAllPsnData() {
  const auth = await getAuth();
  const [trophySummary, devicesResponse, playedGames, trophyTitles] = await Promise.all([
    getUserTrophyProfileSummary(auth, "me"),
    getAccountDevices(auth).catch(() => ({ accountDevices: [] })),
    fetchAllPlayedGames(auth),
    fetchAllTrophyTitles(auth),
  ]);

  const trophyMap = new Map();
  for (const t of trophyTitles) {
    trophyMap.set(normalizeName(t.trophyTitleName), t);
  }

  const mergedGames = playedGames.map((game) => {
    const duration = parseDuration(game.playDuration);
    const matchedTrophy = trophyMap.get(normalizeName(game.name));

    const earnedTotal = matchedTrophy
      ? matchedTrophy.earnedTrophies.bronze +
        matchedTrophy.earnedTrophies.silver +
        matchedTrophy.earnedTrophies.gold +
        matchedTrophy.earnedTrophies.platinum
      : 0;

    const definedTotal = matchedTrophy
      ? matchedTrophy.definedTrophies.bronze +
        matchedTrophy.definedTrophies.silver +
        matchedTrophy.definedTrophies.gold +
        matchedTrophy.definedTrophies.platinum
      : 0;

    const avgMinutesPerSession =
      game.playCount > 0 ? Math.round(duration.seconds / 60 / game.playCount) : 0;

    return {
      titleId: game.titleId,
      name: game.name,
      platform: game.category.replace("_game", "").toUpperCase(),
      imageUrl: game.imageUrl,
      playCount: game.playCount,
      hours: duration.hours,
      readableTime: duration.readable,
      seconds: duration.seconds,
      avgSessionMins: avgMinutesPerSession,
      firstPlayed: game.firstPlayedDateTime,
      lastPlayed: game.lastPlayedDateTime,
      trophyProgress: matchedTrophy ? `${matchedTrophy.progress}%` : "N/A",
      trophyProgressVal: matchedTrophy ? matchedTrophy.progress : -1,
      trophiesEarned: earnedTotal,
      trophiesDefined: definedTotal,
      hasPlatinum: matchedTrophy ? matchedTrophy.earnedTrophies.platinum > 0 : false,
      npCommunicationId: matchedTrophy ? matchedTrophy.npCommunicationId : null,
      trophyPlatform: matchedTrophy ? matchedTrophy.trophyTitlePlatform : null,
      rawTrophyData: matchedTrophy || null,
    };
  });

  const sortedByHours = [...mergedGames].sort((a, b) => b.hours - a.hours);

  const fullDump = {
    fetchedAt: new Date().toISOString(),
    trophySummary,
    devices: devicesResponse.accountDevices || [],
    mergedGames: sortedByHours,
  };

  fs.writeFileSync(DATA_PATH, JSON.stringify(fullDump, null, 2));
  return fullDump;
}

// 1. Get cached PSN data
app.get("/api/psn-data", (req, res) => {
  if (!fs.existsSync(DATA_PATH)) {
    return res.status(404).json({
      error: "psn_full_data.json not found. Click 'Sync Live PSN Data' to pull it!",
    });
  }
  const rawData = fs.readFileSync(DATA_PATH, "utf-8");
  res.json(JSON.parse(rawData));
});

// 2. Live Sync Endpoint
app.post("/api/sync", async (req, res) => {
  try {
    console.log("🔄 Syncing live data from PlayStation Network...");
    const updatedData = await syncAllPsnData();
    console.log("✅ Sync complete!");
    res.json(updatedData);
  } catch (err) {
    console.error("Sync failed:", err);
    res.status(500).json({ error: err.message || "Failed to sync with PSN." });
  }
});

// 3. Individual Game Trophy Breakdown Endpoint
app.get("/api/game-trophies/:npCommId", async (req, res) => {
  try {
    const { npCommId } = req.params;
    const platform = req.query.platform || "PS5";
    const isPS5 = platform.toUpperCase().includes("PS5");
    // PS3/PS4/PSVita require npServiceName: "trophy", whereas PS5 uses default (trophy2)
    const options = isPS5 ? {} : { npServiceName: "trophy" };

    const auth = await getAuth();
    const [titleTrophiesRes, earnedTrophiesRes] = await Promise.all([
      getTitleTrophies(auth, npCommId, "all", options),
      getUserTrophiesEarnedForTitle(auth, "me", npCommId, "all", options),
    ]);

    const earnedMap = new Map();
    for (const t of earnedTrophiesRes.trophies || []) {
      earnedMap.set(t.trophyId, t);
    }

    const mergedTrophies = (titleTrophiesRes.trophies || []).map((t) => {
      const userTrophy = earnedMap.get(t.trophyId) || {};
      return {
        trophyId: t.trophyId,
        name: t.trophyName,
        detail: t.trophyDetail,
        type: t.trophyType, // bronze, silver, gold, platinum
        iconUrl: t.trophyIconUrl,
        hidden: t.trophyHidden,
        earned: Boolean(userTrophy.earned),
        earnedDateTime: userTrophy.earnedDateTime || null,
        earnRate: userTrophy.trophyEarnedRate || null,
        rarity: userTrophy.trophyRare ?? null,
      };
    });

    res.json({ trophies: mergedTrophies });
  } catch (err) {
    console.error("Failed to fetch game trophies:", err);
    res.status(500).json({ error: "Could not load trophies for this title." });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 PSN Telemetry Server running at http://localhost:${PORT}`);
});