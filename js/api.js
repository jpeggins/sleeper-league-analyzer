// ============ RATE LIMITER ============
// Keeps us well under 1000 calls/min. Max 8 concurrent, 80ms between dispatches.
class RateLimiter {
    constructor(maxConcurrent = 8, minDelayMs = 80) {
        this.maxConcurrent = maxConcurrent;
        this.minDelayMs = minDelayMs;
        this.active = 0;
        this.queue = [];
        this.totalQueued = 0;
        this.totalDone = 0;
        this.onProgress = null;
    }

    async fetch(path) {
        return new Promise((resolve, reject) => {
            this.queue.push({ path, resolve, reject });
            this.totalQueued++;
            this._drain();
        });
    }

    async _drain() {
        if (this.active >= this.maxConcurrent || this.queue.length === 0) return;
        this.active++;
        const { path, resolve, reject } = this.queue.shift();

        try {
            await this._delay(this.minDelayMs);
            const res = await fetch(`${API_BASE}${path}`);
            if (!res.ok) throw new Error(`API ${res.status}: ${path}`);
            const data = await res.json();
            this.totalDone++;
            if (this.onProgress) this.onProgress(this.totalDone, this.totalQueued);
            resolve(data);
        } catch (e) {
            this.totalDone++;
            if (this.onProgress) this.onProgress(this.totalDone, this.totalQueued);
            resolve(null); // resolve with null on error so we don't break Promise.all
        } finally {
            this.active--;
            this._drain();
        }
    }

    _delay(ms) {
        return new Promise(r => setTimeout(r, ms));
    }

    reset() {
        this.totalQueued = 0;
        this.totalDone = 0;
    }
}

const rateLimiter = new RateLimiter(8, 80);

// ============ MULTI-YEAR LEAGUE CHAIN ============
async function selectLeague(leagueId) {
    hide('league-section');
    setLoading('Discovering league history...');
    seasonData = {};
    // Clear positional ranking cache from previous analysis
    Object.keys(_posRankCache).forEach(k => delete _posRankCache[k]);

    try {
        // Step 1: Chain backwards via previous_league_id to find all seasons
        const leagueChain = await discoverLeagueChain(leagueId);
        setLoading(`Found ${leagueChain.length} season(s). Loading data...`);

        // Step 2: Load player database if needed
        if (!playerCache) {
            setLoading('Loading player database (~5MB, one-time download)...');
            try {
                const res = await fetch(`${API_BASE}/players/nfl`);
                playerCache = await res.json();
            } catch (e) {
                console.warn('Player DB failed, using IDs');
                playerCache = {};
            }
        }

        // Step 3: For each season, fetch all required data with rate limiting
        rateLimiter.reset();
        rateLimiter.onProgress = showProgress;
        show('progress-container');

        for (const league of leagueChain) {
            await loadSeasonData(league);
        }

        hideLoading();
        renderResults();
        show('results-section');
    } catch (e) {
        hideLoading();
        console.error(e);
        alert('Error loading league data: ' + e.message);
        show('league-section');
    }
}

async function discoverLeagueChain(startLeagueId) {
    // Step 1: Fetch the starting league
    const startRes = await fetch(`${API_BASE}/league/${startLeagueId}`);
    if (!startRes.ok) return [];
    const startLeague = await startRes.json();
    if (!startLeague || !startLeague.league_id) return [];

    // Step 2: Walk backward via previous_league_id
    const backward = [startLeague];
    let prevId = startLeague.previous_league_id;
    while (prevId && backward.length < 10) {
        try {
            const res = await fetch(`${API_BASE}/league/${prevId}`);
            if (!res.ok) break;
            const league = await res.json();
            if (!league || !league.league_id) break;
            backward.push(league);
            prevId = league.previous_league_id;
        } catch (e) { break; }
    }

    // Step 3: Walk forward — Sleeper has no next_league_id, so check user's
    // leagues for the next year and find one whose previous_league_id matches
    const forward = [];
    let currentLeague = startLeague;
    while (forward.length + backward.length < 10) {
        const nextSeason = String(parseInt(currentLeague.season) + 1);
        try {
            const res = await fetch(`${API_BASE}/user/${currentUser.user_id}/leagues/nfl/${nextSeason}`);
            if (!res.ok) break;
            const leagues = await res.json();
            if (!leagues || leagues.length === 0) break;
            const next = leagues.find(l => l.previous_league_id === currentLeague.league_id);
            if (!next) break;
            forward.push(next);
            currentLeague = next;
        } catch (e) { break; }
    }

    // Combine: oldest→newest
    return [...backward.reverse(), ...forward];
}

async function loadSeasonData(league) {
    const lid = league.league_id;
    const season = league.season;
    setLoading(`Loading ${season} season data...`);

    // Parallel fetches for core data
    const [users, rosters, winnersBracket, drafts] = await Promise.all([
        rateLimiter.fetch(`/league/${lid}/users`),
        rateLimiter.fetch(`/league/${lid}/rosters`),
        rateLimiter.fetch(`/league/${lid}/winners_bracket`),
        rateLimiter.fetch(`/league/${lid}/drafts`)
    ]);

    // Fetch draft picks for each draft
    let allDraftPicks = [];
    if (drafts && drafts.length > 0) {
        const pickResults = await Promise.all(
            drafts.map(d => rateLimiter.fetch(`/draft/${d.draft_id}/picks`))
        );
        pickResults.forEach(picks => {
            if (picks) allDraftPicks.push(...picks);
        });
    }

    // Fetch matchups for all weeks (need this to determine starters)
    const totalWeeks = 18;
    const matchupPromises = [];
    for (let w = 1; w <= totalWeeks; w++) {
        matchupPromises.push(rateLimiter.fetch(`/league/${lid}/matchups/${w}`));
    }
    const matchupsByWeek = await Promise.all(matchupPromises);

    // Fetch transactions for all weeks
    const txPromises = [];
    for (let w = 1; w <= totalWeeks; w++) {
        txPromises.push(rateLimiter.fetch(`/league/${lid}/transactions/${w}`));
    }
    const txByWeek = await Promise.all(txPromises);

    // Process transactions
    const allTransactions = [];
    (txByWeek || []).forEach((weekTxs, idx) => {
        if (!weekTxs) return;
        weekTxs.forEach(tx => {
            tx._week = idx + 1;
            tx._season = season;
        });
        allTransactions.push(...weekTxs);
    });

    // Process matchups into a lookup: { week: { roster_id: { starters, players, players_points, points } } }
    const matchups = {};
    (matchupsByWeek || []).forEach((weekData, idx) => {
        if (!weekData) return;
        const week = idx + 1;
        matchups[week] = {};
        weekData.forEach(m => {
            matchups[week][m.roster_id] = {
                starters: m.starters || [],
                players: m.players || [],
                players_points: m.players_points || {},
                points: m.points || 0
            };
        });
    });

    // Determine winner
    const winnerResult = determineWinner(winnersBracket, rosters || []);

    seasonData[season] = {
        league,
        users: users || [],
        rosters: rosters || [],
        drafts: drafts || [],
        draftPicks: allDraftPicks,
        matchups,
        transactions: allTransactions,
        winner: winnerResult.rosterId,
        winnerConfirmed: winnerResult.confirmed
    };
}

function determineWinner(bracket, rosters) {
    if (!bracket || bracket.length === 0) {
        // No bracket - use best regular season record (unconfirmed)
        const sorted = [...rosters].sort((a, b) => {
            const diff = (b.settings?.wins || 0) - (a.settings?.wins || 0);
            return diff !== 0 ? diff : (b.settings?.fpts || 0) - (a.settings?.fpts || 0);
        });
        return { rosterId: sorted[0]?.roster_id || null, confirmed: false };
    }
    // Try p === 1 (placement field, if league uses it)
    const champByPlacement = bracket.find(m => m.p === 1);
    if (champByPlacement?.w) return { rosterId: champByPlacement.w, confirmed: true };

    // Find the championship match: highest round, matchup m === 1
    const maxRound = Math.max(...bracket.map(m => m.r || 0));
    if (maxRound > 0) {
        const finalMatch = bracket.find(m => m.r === maxRound && m.m === 1);
        if (finalMatch?.w) return { rosterId: finalMatch.w, confirmed: true };
    }

    // Fallback: best regular season record (unconfirmed)
    const sorted = [...rosters].sort((a, b) => {
        const diff = (b.settings?.wins || 0) - (a.settings?.wins || 0);
        return diff !== 0 ? diff : (b.settings?.fpts || 0) - (a.settings?.fpts || 0);
    });
    return { rosterId: sorted[0]?.roster_id || null, confirmed: false };
}
