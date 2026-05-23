// ============ COLLAPSIBLE HELPER ============
let _collapseCounter = 0;
function renderCollapsible(container, items, defaultCount = 5) {
    if (items.length <= defaultCount) {
        container.innerHTML = items.join('');
        return;
    }
    const id = `collapse-${_collapseCounter++}`;
    const visible = items.slice(0, defaultCount).join('');
    const hidden = items.slice(defaultCount).join('');
    container.innerHTML = `
        ${visible}
        <div id="${id}" class="hidden">${hidden}</div>
        <button onclick="
            const el = document.getElementById('${id}');
            const btn = this;
            if (el.classList.contains('hidden')) {
                el.classList.remove('hidden');
                btn.textContent = 'Show less';
            } else {
                el.classList.add('hidden');
                btn.textContent = 'Show all ${items.length}';
            }
        " class="w-full text-center text-xs text-sleeper-accent hover:text-white py-2 mt-1 transition-colors">Show all ${items.length}</button>
    `;
}

// ============ RENDER RESULTS ============
function renderResults() {
    const seasons = Object.keys(seasonData).sort();
    const firstSeason = seasonData[seasons[0]];

    // Header
    document.getElementById('league-name').textContent = firstSeason.league.name;
    document.getElementById('league-meta').textContent = `${seasons.join(', ')} · ${seasons.length} season(s) · ${firstSeason.league.total_rosters} teams`;

    // Summary stats
    let totalPicks = 0, totalWaivers = 0, totalTrades = 0;
    for (const sd of Object.values(seasonData)) {
        totalPicks += sd.draftPicks.length;
        totalTrades += sd.transactions.filter(t => t.type === 'trade' && t.status === 'complete').length;
        totalWaivers += sd.transactions.filter(t => (t.type === 'waiver' || t.type === 'free_agent') && t.status === 'complete').length;
    }

    document.getElementById('stat-seasons').textContent = seasons.length;
    document.getElementById('stat-total-picks').textContent = totalPicks;
    document.getElementById('stat-total-waivers').textContent = totalWaivers;
    document.getElementById('stat-total-trades').textContent = totalTrades;

    renderSeasonBreakdown();
    renderDraftHits();
    // renderDraftBustsByRound(); // DISABLED
    renderWaiverGems();
    renderWaiverBusts();
    renderWaiverHitRate();
    renderTradeVolume();
    renderWorstTrades();
    renderKingmaker();
}

function renderDraftHits() {
    const container = document.getElementById('draft-hits');
    // Per-manager draft hit rate, with player-name detail
    const managerStats = {}; // owner_id -> { hits, busts, total, hitPlayers, bustPlayers }

    for (const [season, sd] of Object.entries(seasonData)) {
        const rosterOwnerMap = {};
        sd.rosters.forEach(r => { rosterOwnerMap[r.roster_id] = r.owner_id; });

        sd.draftPicks.forEach(pick => {
            const rosterId = parseInt(pick.roster_id);
            const ownerId = rosterOwnerMap[rosterId];
            if (!ownerId) return;

            const playerId = pick.player_id;
            if (!playerId) return;

            if (!playerScoredInLeague(season, playerId)) return;

            const effectiveTopN = getEffectiveTopN(playerId, 10);
            const { topWeeks, rosteredWeeks, totalPoints } = getHitWeeks(season, rosterId, playerId, 1, effectiveTopN);
            if (rosteredWeeks < 2) return;

            // K/DEF need top-2 consistently — skip from bust/hit unless they meet that bar
            if (isExcludedPosition(playerId) && topWeeks < 4) return;

            const wasDropped = getDropWeek(season, rosterId, playerId) !== null;
            const isHit = topWeeks >= 4 && !wasDropped;

            if (!managerStats[ownerId]) managerStats[ownerId] = { hits: 0, busts: 0, total: 0, hitPlayers: [], bustPlayers: [] };
            managerStats[ownerId].total++;
            if (isHit) {
                managerStats[ownerId].hits++;
                if (managerStats[ownerId].hitPlayers.length < 3) {
                    managerStats[ownerId].hitPlayers.push(getPlayerShort(playerId));
                }
            }
            if (wasDropped) {
                managerStats[ownerId].busts++;
                if (managerStats[ownerId].bustPlayers.length < 2) {
                    managerStats[ownerId].bustPlayers.push(`${getPlayerShort(playerId)} (Rd${pick.round})`);
                }
            }
        });
    }

    const sorted = Object.entries(managerStats)
        .map(([ownerId, stats]) => ({
            name: getManagerName(ownerId),
            hitRate: stats.total > 0 ? (stats.hits / stats.total) : 0,
            hits: stats.hits,
            busts: stats.busts,
            total: stats.total,
            hitPlayers: stats.hitPlayers,
            bustPlayers: stats.bustPlayers
        }))
        .filter(m => m.total >= 3)
        .sort((a, b) => b.hitRate - a.hitRate);

    if (sorted.length === 0) {
        container.innerHTML = '<p class="text-gray-400 text-sm">Not enough draft data to analyze (players_points may not be available).</p>';
        return;
    }

    const items = sorted.map((m, idx) => {
        const pct = (m.hitRate * 100).toFixed(0);
        const barColor = m.hitRate >= 0.5 ? 'from-sleeper-success to-emerald-400' : m.hitRate >= 0.3 ? 'from-sleeper-warning to-yellow-400' : 'from-sleeper-danger to-red-400';
        const medal = idx === 0 ? '🥇 ' : idx === 1 ? '🥈 ' : idx === 2 ? '🥉 ' : '';
        const hitList = m.hitPlayers.length > 0 ? `<span class="text-sleeper-success">Hits:</span> ${m.hitPlayers.join(', ')}` : '';
        const bustList = m.bustPlayers.length > 0 ? `<span class="text-sleeper-danger">Busts:</span> ${m.bustPlayers.join(', ')}` : '';
        const detail = [hitList, bustList].filter(Boolean).join(' · ');
        return `
            <div class="bg-sleeper-dark rounded-lg p-3">
                <div class="flex items-start justify-between gap-2 mb-2">
                    <span class="text-sm font-medium">${medal}${m.name}</span>
                    <span class="text-xs text-gray-400 whitespace-nowrap">${m.hits} hit / ${m.busts} bust</span>
                </div>
                <div class="bg-sleeper-card rounded-full h-5 overflow-hidden">
                    <div class="h-full bg-gradient-to-r ${barColor} rounded-full flex items-center justify-end pr-2 text-xs font-bold" style="width:${Math.max(pct, 8)}%">${pct}%</div>
                </div>
                ${detail ? `<div class="text-xs text-gray-500 mt-2">${detail}</div>` : ''}
            </div>
        `;
    });
    renderCollapsible(container, items);
}

function renderDraftBustsByRound() {
    const container = document.getElementById('draft-round-busts');
    const roundStats = {}; // round -> { busts, total, bustNames }

    for (const [season, sd] of Object.entries(seasonData)) {
        sd.draftPicks.forEach(pick => {
            const rosterId = parseInt(pick.roster_id);
            const playerId = pick.player_id;
            if (!playerId) return;

            const round = pick.round;
            if (!roundStats[round]) roundStats[round] = { busts: 0, total: 0, bustNames: [] };

            if (!playerScoredInLeague(season, playerId)) return;

            roundStats[round].total++;
            const wasDropped = getDropWeek(season, rosterId, playerId) !== null;
            if (wasDropped) {
                roundStats[round].busts++;
                if (roundStats[round].bustNames.length < 3) {
                    roundStats[round].bustNames.push(getPlayerShort(playerId));
                }
            }
        });
    }

    const rounds = Object.keys(roundStats).map(Number).sort((a, b) => a - b);
    if (rounds.length === 0) {
        container.innerHTML = '<p class="text-gray-400 text-sm">Not enough data.</p>';
        return;
    }

    container.innerHTML = rounds.map(round => {
        const s = roundStats[round];
        if (s.total === 0) return '';
        const bustPct = ((s.busts / s.total) * 100).toFixed(0);
        const barWidth = Math.max(parseInt(bustPct), 5);
        const names = s.bustNames.length > 0 ? s.bustNames.join(', ') : '';
        return `
            <div class="mb-1">
                <div class="flex items-center gap-3">
                    <div class="w-16 text-sm text-gray-300">Rd ${round}</div>
                    <div class="flex-1 bg-sleeper-dark rounded-full h-4 overflow-hidden">
                        <div class="h-full bg-gradient-to-r from-sleeper-danger to-red-400 rounded-full flex items-center justify-end pr-2 text-[10px] font-bold" style="width:${barWidth}%">${bustPct}%</div>
                    </div>
                    <div class="text-xs text-gray-500 w-14 text-right">${s.busts}/${s.total}</div>
                </div>
                ${names ? `<div class="text-xs text-gray-500 ml-16 mt-0.5 pl-3">${names}</div>` : ''}
            </div>
        `;
    }).filter(Boolean).join('');
}

function renderWaiverGems() {
    const container = document.getElementById('waiver-gems');
    // Player-focused: show each gem player (4+ top-10 positional weeks, kept on roster)
    const gems = []; // { player, position, season, manager, topWeeks, totalPoints, rosteredWeeks }

    for (const [season, sd] of Object.entries(seasonData)) {
        const rosterOwnerMap = {};
        sd.rosters.forEach(r => { rosterOwnerMap[r.roster_id] = r.owner_id; });

        const waiverTxs = sd.transactions.filter(t =>
            (t.type === 'waiver' || t.type === 'free_agent') && t.status === 'complete' && t.adds
        );

        waiverTxs.forEach(tx => {
            const week = tx._week;
            const lastWeek = getLastAnalysisWeek(season);
            if (week > lastWeek) return;

            Object.entries(tx.adds).forEach(([playerId, rosterId]) => {
                const ownerId = rosterOwnerMap[rosterId];
                if (!ownerId) return;
                if (!playerScoredInLeague(season, playerId)) return;

                const effectiveTopN = getEffectiveTopN(playerId, 10);
                const { topWeeks, rosteredWeeks, totalPoints } = getHitWeeks(season, rosterId, playerId, week, effectiveTopN);
                if (rosteredWeeks < 2) return;

                // K/DEF excluded unless top-2 consistently
                if (isExcludedPosition(playerId) && topWeeks < 4) return;

                const wasDropped = getDropWeek(season, rosterId, playerId) !== null;
                if (topWeeks >= 4 && !wasDropped) {
                    gems.push({
                        player: getPlayerShort(playerId),
                        position: getPlayerPosition(playerId) || '??',
                        season,
                        manager: getManagerName(ownerId),
                        topWeeks,
                        topN: effectiveTopN,
                        totalPoints,
                        rosteredWeeks
                    });
                }
            });
        });
    }

    gems.sort((a, b) => b.topWeeks - a.topWeeks || b.totalPoints - a.totalPoints);

    if (gems.length === 0) {
        container.innerHTML = '<p class="text-gray-400 text-sm">No waiver gems found (4+ top-10 positional weeks required).</p>';
        return;
    }

    const items = gems.slice(0, 20).map((g, idx) => {
        const medal = idx === 0 ? '💎 ' : '';
        return `
            <div class="bg-sleeper-dark rounded-lg p-3">
                <div class="flex items-center justify-between">
                    <span class="text-sm font-semibold">${medal}${g.player} <span class="text-xs text-sleeper-accent">${g.position}</span></span>
                    <span class="text-sleeper-success font-bold text-sm">${g.topWeeks} top-${g.topN} weeks</span>
                </div>
                <div class="text-xs text-gray-400 mt-1">${g.totalPoints.toFixed(1)} pts over ${g.rosteredWeeks} wks · Picked up by ${g.manager} · ${g.season}</div>
            </div>
        `;
    });
    renderCollapsible(container, items);
}

function renderWaiverBusts() {
    const container = document.getElementById('waiver-busts');
    // Player-focused: show each busted FAAB pickup (spent money, then dropped)
    const busts = []; // { player, position, season, manager, faabSpent }

    for (const [season, sd] of Object.entries(seasonData)) {
        const rosterOwnerMap = {};
        sd.rosters.forEach(r => { rosterOwnerMap[r.roster_id] = r.owner_id; });

        const waiverTxs = sd.transactions.filter(t =>
            t.type === 'waiver' && t.status === 'complete' && t.adds && t.settings?.waiver_bid != null
        );

        waiverTxs.forEach(tx => {
            const week = tx._week;
            const lastWeek = getLastAnalysisWeek(season);
            if (week > lastWeek) return;

            const faabSpent = tx.settings.waiver_bid || 0;
            if (faabSpent === 0) return;

            Object.entries(tx.adds).forEach(([playerId, rosterId]) => {
                const ownerId = rosterOwnerMap[rosterId];
                if (!ownerId) return;
                if (!playerScoredInLeague(season, playerId)) return;

                // Skip K/DEF from bust tracking
                if (isExcludedPosition(playerId)) return;

                const wasDropped = getDropWeek(season, rosterId, playerId) !== null;
                if (wasDropped) {
                    busts.push({
                        player: getPlayerShort(playerId),
                        position: getPlayerPosition(playerId) || '??',
                        season,
                        manager: getManagerName(ownerId),
                        faabSpent
                    });
                }
            });
        });
    }

    busts.sort((a, b) => b.faabSpent - a.faabSpent);

    if (busts.length === 0) {
        container.innerHTML = '<p class="text-gray-400 text-sm">No FAAB waiver busts found (league may use rolling waivers).</p>';
        return;
    }

    const items = busts.slice(0, 20).map((b, idx) => {
        const isWorst = idx === 0;
        return `
            <div class="bg-sleeper-dark rounded-lg p-3 ${isWorst ? 'border border-sleeper-danger' : ''}">
                <div class="flex items-center justify-between">
                    <span class="text-sm font-semibold ${isWorst ? 'text-sleeper-danger' : ''}">${isWorst ? '🔥 ' : ''}${b.player} <span class="text-xs text-sleeper-accent">${b.position}</span></span>
                    <span class="text-sm font-bold ${isWorst ? 'text-sleeper-danger' : 'text-gray-300'}">$${b.faabSpent} wasted</span>
                </div>
                <div class="text-xs text-gray-400 mt-1">Picked up & dropped by ${b.manager} · ${b.season}</div>
            </div>
        `;
    });
    renderCollapsible(container, items);
}

function renderWaiverHitRate() {
    const container = document.getElementById('waiver-hit-rate');
    // Hit = pickup had 4+ top-10 positional weeks. Manager-focused with player names.
    const managerStats = {}; // owner_id -> { hits, total, bestPlayers }

    for (const [season, sd] of Object.entries(seasonData)) {
        const rosterOwnerMap = {};
        sd.rosters.forEach(r => { rosterOwnerMap[r.roster_id] = r.owner_id; });

        const waiverTxs = sd.transactions.filter(t =>
            (t.type === 'waiver' || t.type === 'free_agent') && t.status === 'complete' && t.adds
        );

        waiverTxs.forEach(tx => {
            const week = tx._week;
            const lastWeek = getLastAnalysisWeek(season);
            if (week > lastWeek) return;

            Object.entries(tx.adds).forEach(([playerId, rosterId]) => {
                const ownerId = rosterOwnerMap[rosterId];
                if (!ownerId) return;
                if (!playerScoredInLeague(season, playerId)) return;

                // Skip K/DEF unless top-2 at position
                const effectiveTopN = getEffectiveTopN(playerId, 10);
                const { topWeeks, rosteredWeeks } = getHitWeeks(season, rosterId, playerId, week, effectiveTopN);
                if (rosteredWeeks < 1) return;
                if (isExcludedPosition(playerId) && topWeeks < 4) return;

                if (!managerStats[ownerId]) managerStats[ownerId] = { hits: 0, total: 0, bestPlayers: [] };
                managerStats[ownerId].total++;
                if (topWeeks >= 4) {
                    managerStats[ownerId].hits++;
                    if (managerStats[ownerId].bestPlayers.length < 3) {
                        managerStats[ownerId].bestPlayers.push(getPlayerShort(playerId));
                    }
                }
            });
        });
    }

    const sorted = Object.entries(managerStats)
        .map(([ownerId, stats]) => ({
            name: getManagerName(ownerId),
            hitRate: stats.total > 0 ? stats.hits / stats.total : 0,
            hits: stats.hits,
            total: stats.total,
            bestPlayers: stats.bestPlayers
        }))
        .filter(m => m.total >= 5)
        .sort((a, b) => b.hitRate - a.hitRate);

    if (sorted.length === 0) {
        container.innerHTML = '<p class="text-gray-400 text-sm">Not enough waiver data.</p>';
        return;
    }

    const max = sorted[0].hitRate;
    const items = sorted.map(m => {
        const pct = (m.hitRate * 100).toFixed(0);
        const barWidth = max > 0 ? Math.max((m.hitRate / max) * 100, 8) : 8;
        const playerList = m.bestPlayers.length > 0 ? m.bestPlayers.join(', ') : '';
        return `
            <div class="bg-sleeper-dark rounded-lg p-3">
                <div class="flex items-start justify-between gap-2 mb-2">
                    <span class="text-sm font-medium">${m.name}</span>
                    <span class="text-xs text-gray-400 whitespace-nowrap">${m.hits}/${m.total} hits</span>
                </div>
                <div class="bg-sleeper-card rounded-full h-4 overflow-hidden">
                    <div class="h-full bg-gradient-to-r from-sleeper-success to-emerald-400 rounded-full flex items-center justify-end pr-2 text-[10px] font-bold" style="width:${barWidth}%">${pct}%</div>
                </div>
                ${playerList ? `<div class="text-xs text-gray-500 mt-2">${playerList}</div>` : ''}
            </div>
        `;
    });
    renderCollapsible(container, items);
}

function renderTradeVolume() {
    const container = document.getElementById('trade-volume');
    const counts = {}; // owner_id -> count

    for (const sd of Object.values(seasonData)) {
        const rosterOwnerMap = {};
        sd.rosters.forEach(r => { rosterOwnerMap[r.roster_id] = r.owner_id; });

        const trades = sd.transactions.filter(t => t.type === 'trade' && t.status === 'complete');
        trades.forEach(t => {
            (t.roster_ids || []).forEach(rid => {
                const ownerId = rosterOwnerMap[rid];
                if (ownerId) counts[ownerId] = (counts[ownerId] || 0) + 1;
            });
        });
    }

    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const max = sorted[0]?.[1] || 1;

    if (sorted.length === 0) {
        container.innerHTML = '<p class="text-gray-400 text-sm">No trades found.</p>';
        return;
    }

    const items = sorted.map(([ownerId, count]) => {
        const pct = (count / max * 100).toFixed(0);
        const name = getManagerName(ownerId);
        return `
            <div class="bg-sleeper-dark rounded-lg p-3">
                <div class="flex items-start justify-between gap-2 mb-2">
                    <span class="text-sm font-medium">${name}</span>
                    <span class="text-xs text-gray-400 whitespace-nowrap">${count} trades</span>
                </div>
                <div class="bg-sleeper-card rounded-full h-5 overflow-hidden">
                    <div class="h-full bg-gradient-to-r from-sleeper-accent to-sleeper-highlight rounded-full flex items-center justify-end pr-2 text-xs font-bold" style="width:${pct}%">${count}</div>
                </div>
            </div>
        `;
    });
    renderCollapsible(container, items);
}

function renderWorstTrades() {
    const container = document.getElementById('worst-trades');
    const tradeResults = [];

    // Score a player's ROS value by average positional rank
    // Lower avgRank = better player. Returns { avgRank, weeksPlayed, name, pos, rankLabel }
    function scorePlayerROS(season, playerId, fromWeek) {
        const lastWeek = getLastAnalysisWeek(season);
        const sd = seasonData[season];
        const pos = getPlayerPosition(playerId) || '??';
        const name = getPlayerShort(playerId);
        if (!sd) return { avgRank: 99, weeksPlayed: 0, name, pos, rankLabel: '??' };

        let weeksPlayed = 0;
        let rankSum = 0;

        for (let w = fromWeek + 1; w <= lastWeek; w++) {
            const weekData = sd.matchups[w];
            if (!weekData) continue;

            for (const rid of Object.keys(weekData)) {
                const roster = weekData[rid].players || [];
                if (!roster.includes(playerId)) continue;
                const pp = weekData[rid].players_points || {};
                if (pp[playerId] == null || pp[playerId] <= 0) break;

                weeksPlayed++;
                const rankings = getPositionalRankings(season, w);
                if (rankings[pos]) {
                    const idx = rankings[pos].findIndex(r => r.playerId === playerId);
                    rankSum += idx >= 0 ? (idx + 1) : rankings[pos].length;
                } else {
                    rankSum += 20; // default if position not found
                }
                break;
            }
        }

        const avgRank = weeksPlayed > 0 ? rankSum / weeksPlayed : 99;
        const rankLabel = weeksPlayed >= 2 ? `avg ${pos}${Math.round(avgRank)}` : 'N/A';
        return { avgRank, weeksPlayed, name, pos, rankLabel };
    }

    for (const [season, sd] of Object.entries(seasonData)) {
        const rosterOwnerMap = {};
        sd.rosters.forEach(r => { rosterOwnerMap[r.roster_id] = r.owner_id; });

        const lastWeek = getLastAnalysisWeek(season);
        const trades = sd.transactions.filter(t => t.type === 'trade' && t.status === 'complete' && t._week <= lastWeek);

        trades.forEach(t => {
            const adds = t.adds || {};
            const drops = t.drops || {};
            const rids = t.roster_ids || [];
            if (rids.length !== 2) return;

            const [rid1, rid2] = rids;
            const r1Got = [], r1Gave = [];
            const r2Got = [], r2Gave = [];

            for (const [pid, toRid] of Object.entries(adds)) {
                if (parseInt(toRid) === parseInt(rid1)) r1Got.push(pid);
                if (parseInt(toRid) === parseInt(rid2)) r2Got.push(pid);
            }
            for (const [pid, fromRid] of Object.entries(drops)) {
                if (parseInt(fromRid) === parseInt(rid1)) r1Gave.push(pid);
                if (parseInt(fromRid) === parseInt(rid2)) r2Gave.push(pid);
            }

            if (r1Gave.length === 0 || r2Gave.length === 0) return;

            // Score each player
            const r1GaveScores = r1Gave.map(pid => scorePlayerROS(season, pid, t._week));
            const r1GotScores = r1Got.map(pid => scorePlayerROS(season, pid, t._week));
            const r2GaveScores = r2Gave.map(pid => scorePlayerROS(season, pid, t._week));
            const r2GotScores = r2Got.map(pid => scorePlayerROS(season, pid, t._week));

            // Filter to players who actually played 2+ weeks
            const r1GaveActive = r1GaveScores.filter(s => s.weeksPlayed >= 2);
            const r1GotActive = r1GotScores.filter(s => s.weeksPlayed >= 2);
            const r2GaveActive = r2GaveScores.filter(s => s.weeksPlayed >= 2);
            const r2GotActive = r2GotScores.filter(s => s.weeksPlayed >= 2);

            if (r1GaveActive.length === 0 && r2GaveActive.length === 0) return;

            // Best player each side gave away (lowest avg rank = best)
            const bestR1Gave = r1GaveActive.length > 0 ? Math.min(...r1GaveActive.map(s => s.avgRank)) : 99;
            const bestR1Got = r1GotActive.length > 0 ? Math.min(...r1GotActive.map(s => s.avgRank)) : 99;
            const bestR2Gave = r2GaveActive.length > 0 ? Math.min(...r2GaveActive.map(s => s.avgRank)) : 99;
            const bestR2Got = r2GotActive.length > 0 ? Math.min(...r2GotActive.map(s => s.avgRank)) : 99;

            // Each side's trade value: best player they gave away vs best they received
            // Negative = gave away a better player than you got back
            const r1Value = bestR1Gave - bestR1Got; // positive = gave away worse, got better (good trade)
            const r2Value = bestR2Gave - bestR2Got;

            // The loser has the more negative value (gave away better player than received)
            const loserId = r1Value < r2Value ? rid1 : rid2;
            const winnerId = r1Value < r2Value ? rid2 : rid1;
            const loserValue = Math.abs(Math.min(r1Value, r2Value));

            if (loserValue < 3) return; // skip trades where rank diff is small

            const loserGaveScores = loserId === rid1 ? r1GaveScores : r2GaveScores;
            const loserGotScores = loserId === rid1 ? r1GotScores : r2GotScores;
            const loserBestGave = loserId === rid1 ? bestR1Gave : bestR2Gave;
            const loserBestGot = loserId === rid1 ? bestR1Got : bestR2Got;
            const loserOwnerId = rosterOwnerMap[loserId];
            const winnerOwnerId = rosterOwnerMap[winnerId];

            tradeResults.push({
                season,
                week: t._week,
                loserName: loserOwnerId ? getManagerName(loserOwnerId) : `Team ${loserId}`,
                winnerName: winnerOwnerId ? getManagerName(winnerOwnerId) : `Team ${winnerId}`,
                loserGave: loserGaveScores.map(s => `${s.name} ${s.rankLabel}`),
                loserGot: loserGotScores.map(s => `${s.name} ${s.rankLabel}`),
                loserBestGave: Math.round(loserBestGave),
                loserBestGot: Math.round(loserBestGot),
                rankDiff: Math.round(loserValue)
            });
        });
    }

    // Sort by biggest rank differential
    tradeResults.sort((a, b) => b.rankDiff - a.rankDiff);

    if (tradeResults.length === 0) {
        container.innerHTML = '<p class="text-gray-400 text-sm">No player-for-player trades found, or all trades were roughly even.</p>';
        return;
    }

    const items = tradeResults.slice(0, 15).map((t, idx) => {
        const isWorst = idx === 0;
        return `
            <div class="bg-sleeper-dark rounded-lg p-3 ${isWorst ? 'border border-sleeper-danger' : ''}">
                <div class="flex items-start justify-between gap-2 mb-2">
                    <span class="text-sm font-medium ${isWorst ? 'text-sleeper-danger' : ''}">${isWorst ? '💀 ' : ''}${t.loserName}</span>
                    <span class="text-xs text-gray-400 whitespace-nowrap">${t.season} Wk ${t.week}</span>
                </div>
                <div class="text-xs text-gray-400 space-y-1">
                    <div><span class="text-sleeper-danger">Gave away:</span> ${t.loserGave.join(', ')}</div>
                    <div><span class="text-sleeper-success">Received:</span> ${t.loserGot.join(', ')}</div>
                </div>
                <div class="flex items-center justify-between mt-2">
                    <span class="text-xs text-gray-500">Traded with ${t.winnerName}</span>
                    <span class="text-sm font-bold text-sleeper-danger">${t.rankDiff} rank gap</span>
                </div>
            </div>
        `;
    });
    renderCollapsible(container, items);
}

function renderKingmaker() {
    const container = document.getElementById('kingmaker');
    // Across all seasons, who traded with the eventual champion most?
    const tradedWithChamp = {}; // owner_id -> count

    for (const [season, sd] of Object.entries(seasonData)) {
        // Only count seasons with a bracket-confirmed champion
        if (!sd.winner || !sd.winnerConfirmed) continue;

        const winnerId = parseInt(sd.winner);
        const rosterOwnerMap = {};
        sd.rosters.forEach(r => { rosterOwnerMap[parseInt(r.roster_id)] = r.owner_id; });

        const champOwnerId = rosterOwnerMap[winnerId];
        if (!champOwnerId) continue;

        const trades = sd.transactions.filter(t => t.type === 'trade' && t.status === 'complete');
        trades.forEach(t => {
            const rids = (t.roster_ids || []).map(Number);
            if (rids.includes(winnerId)) {
                rids.forEach(rid => {
                    if (rid !== winnerId) {
                        const ownerId = rosterOwnerMap[rid];
                        if (ownerId && ownerId !== champOwnerId) {
                            tradedWithChamp[ownerId] = (tradedWithChamp[ownerId] || 0) + 1;
                        }
                    }
                });
            }
        });
    }

    const sorted = Object.entries(tradedWithChamp).sort((a, b) => b[1] - a[1]);
    if (sorted.length === 0) {
        container.innerHTML = '<p class="text-gray-400 text-sm">Champions made no trades, or no completed seasons found.</p>';
        return;
    }

    const items = sorted.map(([ownerId, count], idx) => {
        const name = getManagerName(ownerId);
        const crown = idx === 0 ? '👑 ' : '';
        return `
            <div class="flex items-center justify-between bg-sleeper-dark rounded-lg p-3">
                <span class="text-sm font-semibold">${crown}${name}</span>
                <span class="text-sleeper-warning font-bold">${count} trade${count > 1 ? 's' : ''} with champs</span>
            </div>
        `;
    });
    renderCollapsible(container, items);
}

function renderSeasonBreakdown() {
    const container = document.getElementById('season-breakdown');
    const seasons = Object.keys(seasonData).sort();

    container.innerHTML = seasons.map(season => {
        const sd = seasonData[season];
        const trades = sd.transactions.filter(t => t.type === 'trade' && t.status === 'complete').length;
        const waivers = sd.transactions.filter(t => (t.type === 'waiver' || t.type === 'free_agent') && t.status === 'complete').length;
        const picks = sd.draftPicks.length;
        const winnerName = sd.winner ? getTeamName(sd.winner, season) : 'TBD';

        return `
            <div class="bg-sleeper-dark rounded-lg p-4">
                <div class="flex items-center justify-between mb-2">
                    <span class="font-bold text-sleeper-accent">${season}</span>
                    <span class="text-xs text-sleeper-warning">🏆 ${winnerName}</span>
                </div>
                <div class="grid grid-cols-3 gap-2 text-center text-xs">
                    <div><span class="block text-lg font-bold text-gray-200">${picks}</span>Draft Picks</div>
                    <div><span class="block text-lg font-bold text-gray-200">${waivers}</span>Waivers/FA</div>
                    <div><span class="block text-lg font-bold text-gray-200">${trades}</span>Trades</div>
                </div>
            </div>
        `;
    }).join('');
}
