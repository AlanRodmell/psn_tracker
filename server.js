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
const DAILY_LOG_PATH = path.join(__dirname, "psn_daily_log.json");

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

let cachedAuth = null;
let authExpiresAt = 0;

async function getAuth() {
  if (cachedAuth && Date.now() < authExpiresAt) return cachedAuth;
  const npsso = process.env.PSN_NPSSO;
  if (!npsso) throw new Error("Missing PSN_NPSSO in .env file");
  const accessCode = await exchangeNpssoForCode(npsso);
  cachedAuth = await exchangeCodeForAccessToken(accessCode);
  authExpiresAt = Date.now() + 45 * 60 * 1000;
  return cachedAuth;
}

function parseDuration(durationStr) {
  if (!durationStr) return { hours: 0, readable: "0h 0m", seconds: 0 };
  const h = parseInt(durationStr.match(/(\d+)H/)?.[1] || "0", 10);
  const m = parseInt(durationStr.match(/(\d+)M/)?.[1] || "0", 10);
  const s = parseInt(durationStr.match(/(\d+)S/)?.[1] || "0", 10);
  const totalSeconds = h * 3600 + m * 60 + s;
  return {
    hours: +(totalSeconds / 3600).toFixed(2),
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

function updateDailyPlaytimeLog(mergedGames) {
  const todayKey = new Date().toISOString().slice(0, 10);
  let logData = { baselineTotals: {}, days: {} };

  if (fs.existsSync(DAILY_LOG_PATH)) {
    try {
      logData = JSON.parse(fs.readFileSync(DAILY_LOG_PATH, "utf-8"));
    } catch (e) {
      console.warn("Resetting corrupt daily log file.");
    }
  }

  const isFirstEverRun = Object.keys(logData.baselineTotals).length === 0;
  if (!logData.days[todayKey]) {
    logData.days[todayKey] = { totalHours: 0, games: {} };
  }

  for (const g of mergedGames) {
    const prevSeconds = logData.baselineTotals[g.titleId];
    if (!isFirstEverRun && prevSeconds !== undefined && g.seconds > prevSeconds) {
      const deltaHours = +((g.seconds - prevSeconds) / 3600).toFixed(2);
      logData.days[todayKey].totalHours = +(logData.days[todayKey].totalHours + deltaHours).toFixed(2);
      logData.days[todayKey].games[g.name] = +((logData.days[todayKey].games[g.name] || 0) + deltaHours).toFixed(2);
    }
    logData.baselineTotals[g.titleId] = g.seconds;
  }

  fs.writeFileSync(DAILY_LOG_PATH, JSON.stringify(logData, null, 2));
  return logData;
}

async function fetchRecentTrophyTimestamps(auth, mergedGames) {
  const recentWithTrophies = [...mergedGames]
    .sort((a, b) => new Date(b.lastPlayed) - new Date(a.lastPlayed))
    .filter((g) => g.npCommunicationId)
    .slice(0, 12);

  const unlockedEvents = [];

  await Promise.all(
    recentWithTrophies.map(async (g) => {
      try {
        const isPS5 = (g.trophyPlatform || g.platform || "").toUpperCase().includes("PS5");
        const options = isPS5 ? {} : { npServiceName: "trophy" };
        const res = await getUserTrophiesEarnedForTitle(auth, "me", g.npCommunicationId, "all", options);
        for (const t of res.trophies || []) {
          if (t.earned && t.earnedDateTime) {
            unlockedEvents.push({
              game: g.name,
              type: t.trophyType,
              timestamp: t.earnedDateTime,
            });
          }
        }
      } catch (e) {
        // Ignore individual title errors
      }
    })
  );

  return unlockedEvents.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

async function syncAllPsnData() {
  // Preserve existing custom prices, ratings, and notes across syncs
  let existingGameMeta = {};
  if (fs.existsSync(DATA_PATH)) {
    try {
      const existingData = JSON.parse(fs.readFileSync(DATA_PATH, "utf-8"));
      existingGameMeta = existingData.gameMeta || {};
    } catch (e) {}
  }

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
      hasPlatinum: matchedTrophy ? matchedTrophy.earnedTrophies.platinum > 0 : false,
      npCommunicationId: matchedTrophy ? matchedTrophy.npCommunicationId : null,
      trophyPlatform: matchedTrophy ? matchedTrophy.trophyTitlePlatform : null,
      rawTrophyData: matchedTrophy || null,
    };
  });

  const sortedByHours = [...mergedGames].sort((a, b) => b.hours - a.hours);

  console.log("📊 Updating daily playtime log & scanning recent trophy timestamps...");
  const dailyLog = updateDailyPlaytimeLog(mergedGames);
  const recentTrophyEvents = await fetchRecentTrophyTimestamps(auth, mergedGames);

  const fullDump = {
    fetchedAt: new Date().toISOString(),
    trophySummary,
    devices: devicesResponse.accountDevices || [],
    mergedGames: sortedByHours,
    dailyLog,
    recentTrophyEvents,
    gameMeta: existingGameMeta,
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
  const rawData = JSON.parse(fs.readFileSync(DATA_PATH, "utf-8"));
  if (fs.existsSync(DAILY_LOG_PATH) && !rawData.dailyLog) {
    rawData.dailyLog = JSON.parse(fs.readFileSync(DAILY_LOG_PATH, "utf-8"));
  }
  res.json(rawData);
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
        type: t.trophyType,
        iconUrl: t.trophyIconUrl,
        hidden: t.trophyHidden,
        earned: Boolean(userTrophy.earned),
        earnedDateTime: userTrophy.earnedDateTime || null,
        earnRate: userTrophy.trophyEarnedRate || null,
      };
    });

    res.json({ trophies: mergedTrophies });
  } catch (err) {
    console.error("Failed to fetch game trophies:", err);
    res.status(500).json({ error: "Could not load trophies for this title." });
  }
});

// 4. Save Custom Price, Star Rating, and Notes per Game
app.post("/api/update-game-meta", (req, res) => {
  try {
    const { titleId, price, rating, notes } = req.body;
    if (!fs.existsSync(DATA_PATH)) {
      return res.status(404).json({ error: "psn_full_data.json not found" });
    }

    const rawData = JSON.parse(fs.readFileSync(DATA_PATH, "utf-8"));
    if (!rawData.gameMeta) rawData.gameMeta = {};

    const prev = rawData.gameMeta[titleId] || {};
    rawData.gameMeta[titleId] = {
      price: price !== undefined && price !== "" ? parseFloat(price) : (prev.price || 0),
      rating: rating !== undefined ? parseInt(rating, 10) : (prev.rating || 0),
      notes: notes !== undefined ? notes : (prev.notes || ""),
    };

    fs.writeFileSync(DATA_PATH, JSON.stringify(rawData, null, 2));
    res.json({ success: true, gameMeta: rawData.gameMeta });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 PSN Telemetry Server running at http://localhost:${PORT}`);
});