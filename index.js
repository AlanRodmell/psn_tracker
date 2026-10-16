require("dotenv").config();
const fs = require("fs");
const {
  exchangeNpssoForCode,
  exchangeCodeForAccessToken,
  getUserPlayedGames,
  getUserTitles,
  getUserTrophyProfileSummary,
  getAccountDevices,
} = require("psn-api");

// Convert ISO duration ("PT45H20M15S") into total seconds & decimal hours
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

// Normalize titles so "No Man's Sky Trophies" matches "No Man's Sky"
function normalizeName(name = "") {
  return name
    .toLowerCase()
    .replace(/trophies$/i, "")
    .replace(/[™®©]/g, "")
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

// Helper to fetch ALL pages of Played Games
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

// Helper to fetch ALL pages of Trophy Titles
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

async function pullEverything() {
  try {
    console.log("1. Authenticating with PlayStation...");
    const npsso = process.env.PSN_NPSSO;
    const accessCode = await exchangeNpssoForCode(npsso);
    const auth = await exchangeCodeForAccessToken(accessCode);

    console.log("2. Fetching Trophy Profile Summary & Consoles...");
    const [trophySummary, devicesResponse] = await Promise.all([
      getUserTrophyProfileSummary(auth, "me"),
      getAccountDevices(auth).catch(() => ({ accountDevices: [] })),
    ]);

    console.log("3. Fetching full Playtime History (all pages)...");
    const playedGames = await fetchAllPlayedGames(auth);

    console.log("4. Fetching full Trophy List (all pages)...");
    const trophyTitles = await fetchAllTrophyTitles(auth);

    // Map trophy data by normalized name for cross-referencing
    const trophyMap = new Map();
    for (const t of trophyTitles) {
      trophyMap.set(normalizeName(t.trophyTitleName), t);
    }

    // Merge Played Games + Trophy Stats into one rich dataset
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
        game.playCount > 0 ? Math.round((duration.seconds / 60) / game.playCount) : 0;

      return {
        titleId: game.titleId,
        name: game.name,
        platform: game.category.replace("_game", "").toUpperCase(),
        imageUrl: game.imageUrl,
        playCount: game.playCount,
        hours: duration.hours,
        readableTime: duration.readable,
        avgSessionMins: avgMinutesPerSession,
        firstPlayed: game.firstPlayedDateTime,
        lastPlayed: game.lastPlayedDateTime,
        trophyProgress: matchedTrophy ? `${matchedTrophy.progress}%` : "N/A",
        trophiesEarned: earnedTotal,
        hasPlatinum: matchedTrophy ? matchedTrophy.earnedTrophies.platinum > 0 : false,
        rawTrophyData: matchedTrophy || null,
      };
    });

    // Sort by most hours played
    const sortedByHours = [...mergedGames].sort((a, b) => b.hours - a.hours);

    // Calculate Headline Stats
    const totalHours = mergedGames.reduce((sum, g) => sum + g.hours, 0).toFixed(1);
    const totalSessions = mergedGames.reduce((sum, g) => sum + (g.playCount || 0), 0);

    console.log("\n==========================================");
    console.log("       PLAYSTATION PROFILE OVERVIEW       ");
    console.log("==========================================");
    console.log(`Account ID:      ${trophySummary.accountId}`);
    console.log(`Trophy Level:    ${trophySummary.trophyLevel} (${trophySummary.progress}% to next)`);
    console.log(
      `Total Trophies:  🏆 ${trophySummary.earnedTrophies.platinum} Plat | 🥇 ${trophySummary.earnedTrophies.gold} Gold | 🥈 ${trophySummary.earnedTrophies.silver} Silver | 🥉 ${trophySummary.earnedTrophies.bronze} Bronze`
    );
    console.log(`Games Tracked:   ${mergedGames.length} played titles (${trophyTitles.length} trophy lists)`);
    console.log(`Total Playtime:  ${totalHours} hours across ${totalSessions} game launches`);
    if (devicesResponse.accountDevices?.length) {
      const deviceTypes = devicesResponse.accountDevices.map((d) => d.deviceType).join(", ");
      console.log(`Linked Consoles: ${deviceTypes}`);
    }
    console.log("==========================================\n");

    console.log("TOP 20 MOST PLAYED GAMES (MERGED DATA):");
    console.table(
      sortedByHours.slice(0, 20).map((g) => ({
        Title: g.name.slice(0, 32),
        Plat: g.platform,
        Hours: g.hours,
        Sessions: g.playCount,
        "Avg Session": `${g.avgSessionMins}m`,
        "Trophy %": g.trophyProgress,
        Trophies: g.trophiesEarned,
        FirstPlayed: new Date(g.firstPlayed).toLocaleDateString("en-GB"),
        LastPlayed: new Date(g.lastPlayed).toLocaleDateString("en-GB"),
      }))
    );

    // Save everything to a local JSON file so you can inspect all raw fields
    const fullDump = {
      fetchedAt: new Date().toISOString(),
      trophySummary,
      devices: devicesResponse.accountDevices || [],
      mergedGames: sortedByHours,
      rawPlayedGames: playedGames,
      rawTrophyTitles: trophyTitles,
    };

    fs.writeFileSync("psn_full_data.json", JSON.stringify(fullDump, null, 2));
    console.log("\nSaved complete raw & merged dataset to: psn_full_data.json");
  } catch (error) {
    console.error("Error pulling data:", error);
  }
}

pullEverything();