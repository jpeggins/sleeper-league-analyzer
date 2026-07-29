// ============ ANALYSIS FUNCTIONS ============
const EXCLUDE_LAST_WEEKS = 2; // ignore last 2 weeks (weird roster moves)

// Get the last meaningful week for a season (last week with matchup data minus exclusion)
function getLastAnalysisWeek(season) {
    const sd = seasonData[season];
    if (!sd) return 16;
    let lastWeek = 0;
    for (let w = 1; w <= 18; w++) {
        if (sd.matchups[w] && Object.keys(sd.matchups[w]).length > 0) lastWeek = w;
    }
    return Math.max(1, lastWeek - EXCLUDE_LAST_WEEKS);
}

function getPlayerPosition(playerId) {
    if (!playerCache || !playerCache[playerId]) return null;
    return playerCache[playerId].position || null;
}

// Position-tiered top-N thresholds:
// RB/WR = top 10, QB/TE = top 5, K/DEF = top 2
const POS_TOP_N = { 'RB': 10, 'WR': 10, 'QB': 5, 'TE': 5, 'K': 2, 'DEF': 2 };
function getEffectiveTopN(playerId, defaultTopN) {
    const pos = getPlayerPosition(playerId);
    if (!pos) return defaultTopN;
    return POS_TOP_N[pos] ?? defaultTopN;
}

function isExcludedPosition(playerId) {
    const pos = getPlayerPosition(playerId);
    return pos && (pos === 'K' || pos === 'DEF');
}

// Build positional rankings for a given season+week.
// Returns { 'QB': [{playerId, points}, ...sorted desc], 'RB': [...], ... }
// Caches results for performance.
const _posRankCache = {};
function getPositionalRankings(season, week) {
    const key = `${season}-${week}`;
    if (_posRankCache[key]) return _posRankCache[key];

    const sd = seasonData[season];
    if (!sd || !sd.matchups[week]) { _posRankCache[key] = {}; return {}; }

    const byPos = {};
    const weekData = sd.matchups[week];

    for (const rid of Object.keys(weekData)) {
        const rosterData = weekData[rid];
        const pp = rosterData.players_points || {};
        for (const [pid, pts] of Object.entries(pp)) {
            if (pts == null || pts === 0) continue;
            const pos = getPlayerPosition(pid);
            if (!pos) continue;
            if (!byPos[pos]) byPos[pos] = [];
            byPos[pos].push({ playerId: pid, points: pts });
        }
    }

    // Sort each position descending by points
    for (const pos of Object.keys(byPos)) {
        byPos[pos].sort((a, b) => b.points - a.points);
    }

    _posRankCache[key] = byPos;
    return byPos;
}

// Check if a player finished top-N at their position in a given week (league-wide)
function isTopNAtPosition(season, week, playerId, topN = 20) {
    const pos = getPlayerPosition(playerId);
    if (!pos) return false;
    const rankings = getPositionalRankings(season, week);
    if (!rankings[pos]) return false;
    const idx = rankings[pos].findIndex(r => r.playerId === playerId);
    return idx >= 0 && idx < topN;
}

// Check if a player was rostered on a given team in a given week
function isRosteredOnTeam(season, rosterId, week) {
    const sd = seasonData[season];
    if (!sd || !sd.matchups[week]) return null; // no data for this week
    const rosterData = sd.matchups[week][rosterId];
    if (!rosterData) return null;
    return rosterData.players || [];
}

// Was a player dropped to FA/waivers from a specific roster during the season?
// Returns the week it happened, or null if never dropped.
function getDropWeek(season, rosterId, playerId) {
    const sd = seasonData[season];
    if (!sd) return null;
    const lastWeek = getLastAnalysisWeek(season);

    // Look through transactions for a drop of this player from this roster
    for (const tx of sd.transactions) {
        if (tx._week > lastWeek) continue; // ignore drops in excluded weeks
        if (tx.status !== 'complete') continue;
        if (!tx.drops) continue;
        if (tx.drops[playerId] === rosterId) {
            // This player was dropped from this roster
            // Make sure it's not a trade (trades also show drops)
            if (tx.type !== 'trade') return tx._week;
        }
    }
    return null;
}

// Determine if a player scored points in the league at all (rostered anywhere with >0 pts)
// Used to filter out truly inactive players (IR all year, retired, etc.)
function playerScoredInLeague(season, playerId) {
    const sd = seasonData[season];
    if (!sd) return false;
    for (let w = 1; w <= 18; w++) {
        const weekData = sd.matchups[w];
        if (!weekData) continue;
        for (const rid of Object.keys(weekData)) {
            const pp = weekData[rid].players_points;
            if (pp && pp[playerId] && pp[playerId] > 0) return true;
        }
    }
    return false;
}

// Get the number of top-N positional weeks for a player on a roster
// from acquisitionWeek to lastAnalysisWeek, only counting weeks they were rostered
function getHitWeeks(season, rosterId, playerId, acquisitionWeek, topN = 20) {
    const sd = seasonData[season];
    if (!sd) return { topWeeks: 0, rosteredWeeks: 0, totalPoints: 0 };
    const lastWeek = getLastAnalysisWeek(season);
    let topWeeks = 0;
    let rosteredWeeks = 0;
    let totalPoints = 0;

    for (let w = acquisitionWeek; w <= lastWeek; w++) {
        const weekData = sd.matchups[w];
        if (!weekData || !weekData[rosterId]) continue;
        const roster = weekData[rosterId].players || [];
        if (!roster.includes(playerId)) continue;
        rosteredWeeks++;
        const pts = (weekData[rosterId].players_points || {})[playerId] || 0;
        totalPoints += pts;
        if (isTopNAtPosition(season, w, playerId, topN)) topWeeks++;
    }

    return { topWeeks, rosteredWeeks, totalPoints };
}

// ============ KEEPER ELIGIBILITY ============
// League rule: a drafted player can be kept next year at 2 rounds higher than
// drafted (capped at round 1). The player must remain continuously rostered the
// entire season. Trades are allowed and transfer the keeper right to the new
// owner, PROVIDED the player was never dropped to free agency / waivers at any
// point (that breaks the continuous-ownership chain). Whoever owns the player at
// season's end holds the keeper right.

// Return the most recent season we have data for (i.e. "this year").
function getCurrentSeason() {
    const seasons = Object.keys(seasonData).sort();
    return seasons[seasons.length - 1] || null;
}

// Return the most recent season that actually has a completed draft. Keepers are
// derived from the last DRAFTED season — e.g. in mid-2026 the newest league may
// be the not-yet-drafted 2026 season, so we fall back to 2025's draft.
function getLatestDraftedSeason() {
    const seasons = Object.keys(seasonData).sort();
    for (let i = seasons.length - 1; i >= 0; i--) {
        const sd = seasonData[seasons[i]];
        if (sd && Array.isArray(sd.draftPicks) && sd.draftPicks.length > 0) {
            return seasons[i];
        }
    }
    return null;
}

// Compute the list of keeper-eligible players for a given season.
// Returns an array of:
//   { playerId, draftRound, draftPickNo, keeperRound, capped,
//     originalOwnerId, finalOwnerId, finalRosterId, wasTraded, tradePath }
function computeKeeperEligible(season) {
    const sd = seasonData[season];
    if (!sd) return [];

    // roster_id -> owner_id, and roster_id -> current players set
    const rosterOwnerMap = {};
    const rosterPlayersMap = {};
    sd.rosters.forEach(r => {
        rosterOwnerMap[parseInt(r.roster_id)] = r.owner_id;
        rosterPlayersMap[parseInt(r.roster_id)] = new Set(r.players || []);
    });

    // Completed transactions sorted chronologically (created ascending).
    const txs = (sd.transactions || [])
        .filter(t => t.status === 'complete')
        .slice()
        .sort((a, b) => (a.created || 0) - (b.created || 0) || (a._week || 0) - (b._week || 0));

    // Roster membership at season's end. Prefer the live roster snapshot, but fall
    // back to the last week that has matchup data in case rosters were cleared.
    let lastMatchupWeek = 0;
    for (let w = 1; w <= 18; w++) {
        if (sd.matchups[w] && Object.keys(sd.matchups[w]).length > 0) lastMatchupWeek = w;
    }
    function rosteredAtEnd(rosterId, playerId) {
        const set = rosterPlayersMap[rosterId];
        if (set && set.size > 0) return set.has(playerId);
        // Fallback: last week's matchup roster
        if (lastMatchupWeek && sd.matchups[lastMatchupWeek]?.[rosterId]) {
            return (sd.matchups[lastMatchupWeek][rosterId].players || []).includes(playerId);
        }
        return false;
    }

    const results = [];
    let disqualifiedFA = 0, disqualifiedNotRostered = 0;

    sd.draftPicks.forEach(pick => {
        const playerId = pick.player_id;
        if (!playerId) return;
        const draftRosterId = parseInt(pick.roster_id);
        const round = pick.round;
        if (!round) return;

        let currentRoster = draftRosterId;
        let eligible = true;
        let wasTraded = false;
        const tradePath = []; // [{ week, fromRosterId, toRosterId }]

        for (const tx of txs) {
            const adds = tx.adds || {};
            const drops = tx.drops || {};
            const involvesAdd = Object.prototype.hasOwnProperty.call(adds, playerId);
            const involvesDrop = Object.prototype.hasOwnProperty.call(drops, playerId);
            if (!involvesAdd && !involvesDrop) continue;

            if (tx.type === 'trade') {
                if (involvesAdd) {
                    const toRoster = parseInt(adds[playerId]);
                    tradePath.push({ week: tx._week, fromRosterId: currentRoster, toRosterId: toRoster });
                    currentRoster = toRoster;
                    wasTraded = true;
                }
                // The drop side of a trade is just the giving team; not a break.
            } else {
                // waiver / free_agent / commissioner move touching this player.
                // Any drop to FA, or a pickup from FA, breaks continuous ownership.
                eligible = false;
                break;
            }
        }

        if (!eligible) { disqualifiedFA++; return; }

        // Must still be on the final owner's roster at season's end.
        if (!rosteredAtEnd(currentRoster, playerId)) { disqualifiedNotRostered++; return; }

        const keeperRoundRaw = round - 2;
        const keeperRound = Math.max(1, keeperRoundRaw);

        results.push({
            playerId,
            draftRound: round,
            draftPickNo: pick.pick_no || null,
            keeperRound,
            capped: keeperRoundRaw < 1,
            originalOwnerId: rosterOwnerMap[draftRosterId],
            finalOwnerId: rosterOwnerMap[currentRoster],
            finalRosterId: currentRoster,
            wasTraded,
            tradePath
        });
    });

    console.debug(`[keepers] season=${season} picks=${sd.draftPicks.length} eligible=${results.length} droppedToFA=${disqualifiedFA} notRosteredAtEnd=${disqualifiedNotRostered}`);

    return results;
}
