// @ts-nocheck
// Verbatim APK 12075 functions. Do not format. SHA256 41a81d2529b71de38016cff949fb9731b858869d274ecb4aa179231231c02bd1
// Regenerate: node scripts/extract-endgame.mjs
import {RULES} from '../../rules/src/index.js';
const he=RULES.GameParams,il={v4300:RULES},K={MaxPlayerCount:10,MaxWinnerCount:5,NumWinnersForNumPlayers:[0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1]};
const pe={Mine:0,Factory:1,Generator:2},ke={Ended:1},De={Occupied:1}; let of=null;
class te{static hasTeams(e) {
        return e.teamSize > 0
    }
static teamOf(e, t) {
        return e.teamSize > 0 ? Math.floor(t / e.teamSize) : t
    }
static teamCount(e) {
        return e.teamSize > 0 ? Math.ceil(e.maxPlayerCount / e.teamSize) : e.maxPlayerCount
    }
static teamFirstSeat(e, t) {
        return t < 0 ? 0 : e.teamSize > 0 ? t * e.teamSize : t
    }
static teamEndSeat(e, t) {
        return t < 0 ? 0 : e.teamSize <= 0 ? t + 1 : Math.min(t * e.teamSize + e.teamSize, e.maxPlayerCount)
    }
static getOutpostGoal(e) {
        if (e.noMines == !1) return -1;
        const t = il[`v${e.rulesVersion}`];
        return this.hasTeams(e) ? (t?.GameParams?.TeamDominationRequirementByPlayerCount || il.v4300.GameParams.TeamDominationRequirementByPlayerCount)[e.maxPlayerCount] : (t?.GameParams?.DominationRequirementByPlayerCount || [0, 0, 15, 18, 20, 25, 30, 35, 40, 45, 50])[e.maxPlayerCount]
    }}
class ut{static getTeamOutpostCount(e, t) {
        let r = 0;
        const s = te.teamEndSeat(e.info, t);
        for (let i = te.teamFirstSeat(e.info, t); i < s; i++) r += fy(e.world.cachedValues.get(i));
        return r
    }
static getTeamNeptunium(e, t) {
        let r = 0;
        const s = te.teamEndSeat(e.info, t);
        for (let i = te.teamFirstSeat(e.info, t); i < s; i++) r += e.world.cachedValues.get(i).neptunium;
        return r
    }
static isTeamAlive(e, t) {
        const r = te.teamEndSeat(e.info, t);
        for (let s = te.teamFirstSeat(e.info, t); s < r; s++)
            if (e.playerStates.get(s).timeOfDeathInSecs < 0) return !0;
        return !1
    }
static isGameOver(e, t = null) {
        if (te.hasTeams(e.info)) return $2e(e, t);
        let r = 0,
            s = -1;
        for (let a = 0; a < e.info.maxPlayerCount; a++) {
            if (e.info.noMines) {
                const l = fy(e.world.cachedValues.get(a)),
                    c = te.getOutpostGoal(e.info);
                if (l >= c) return t != null && (t.playerIndex = a), !0
            } else if (e.world.cachedValues.get(a).neptunium >= e.info.neptuniumGoal) return t != null && (t.playerIndex = a), !0;
            e.playerStates.get(a).timeOfDeathInSecs < 0 && (s = a, r++)
        }
        const i = he.RulesVersion >= 24 ? K.NumWinnersForNumPlayers[e.info.maxPlayerCount] : 1;
        return r <= i ? (t != null && (t.playerIndex = s), !0) : !1
    }
static getWinningPlayers(e, t) {
        for (let s = 0; s < K.MaxWinnerCount; ++s) t[s] = -1;
        let r = 0;
        if (e.status == ke.Ended) {
            if (te.hasTeams(e.info)) {
                const a = new Array(K.MaxPlayerCount).fill(-1);
                this.calculateTeamOrder(e, a);
                const o = a[0];
                if (o < 0 || !this.isTeamAlive(e, o)) return 0;
                const l = te.teamEndSeat(e.info, o);
                for (let c = te.teamFirstSeat(e.info, o); c < l && r < K.MaxWinnerCount; ++c) t[r++] = c;
                return r
            }
            let s = new Array(K.MaxPlayerCount);
            this.calculatePlayerTableOrder(e, s);
            const i = K.NumWinnersForNumPlayers[e.info.maxPlayerCount];
            for (let a = 0; a < i; ++a) {
                const o = s[a];
                e.playerStates.get(o).seatState == De.Occupied && (t[a] = s[a], r++)
            }
        }
        return r
    }
static playerTableOrderCompareFunc(e, t) {
        if (e == -1 || t == -1) return 0;
        const r = e,
            s = t,
            i = of.playerStates.get(r),
            a = of.playerStates.get(s);
        if (i.timeOfDeathInSecs >= 0 && a.timeOfDeathInSecs >= 0) return a.timeOfDeathInSecs - i.timeOfDeathInSecs;
        if (i.timeOfDeathInSecs >= 0) return 1;
        if (a.timeOfDeathInSecs >= 0) return -1;
        const o = of.world.cachedValues.get(r),
            l = of.world.cachedValues.get(s),
            c = o.outpostCountByType[pe.Mine],
            u = l.outpostCountByType[pe.Mine],
            d = fy(o),
            h = fy(l);
        if (o.neptunium !== l.neptunium) return l.neptunium - o.neptunium;
        if (c !== u) return u - c;
        if (d !== h) return h - d;
        if (o.drillers !== l.drillers) return l.drillers - o.drillers;
        {
            const p = of.info.players[r].playerId;
            return of.info.players[s].playerId - p
        }
    }
static calculateTeamOrder(e, t) {
        t.fill(-1);
        const r = e.info,
            s = te.teamCount(r),
            i = new Array(s),
            a = new Array(s),
            o = new Array(s);
        for (let l = 0; l < s; l++) o[l] = l, i[l] = this.isTeamAlive(e, l) ? 1 : 0, a[l] = r.noMines ? this.getTeamOutpostCount(e, l) : this.getTeamNeptunium(e, l);
        o.sort((l, c) => i[l] !== i[c] ? i[c] - i[l] : a[l] !== a[c] ? a[c] - a[l] : l - c);
        for (let l = 0; l < s; l++) t[l] = o[l];
        return s
    }
static getTeamRankBySeat(e, t) {
        t.fill(-1, 0, K.MaxPlayerCount);
        const r = new Array(K.MaxPlayerCount).fill(-1),
            s = this.calculateTeamOrder(e, r);
        for (let i = 0; i < s; i++) {
            const a = r[i],
                o = te.teamEndSeat(e.info, a);
            for (let l = te.teamFirstSeat(e.info, a); l < o; l++) t[l] = i
        }
    }
static calculatePlayerTableOrder(e, t) {
        t.fill(-1, 0, K.MaxPlayerCount);
        for (let i = 0; i < e.info.maxPlayerCount; i++) t[i] = i;
        if (te.hasTeams(e.info)) {
            const i = new Array(K.MaxPlayerCount).fill(-1),
                a = this.calculateTeamOrder(e, i);
            let o = 0;
            for (let l = 0; l < a; l++) {
                const c = i[l],
                    u = te.teamEndSeat(e.info, c);
                for (let d = te.teamFirstSeat(e.info, c); d < u; d++) t[o++] = d
            }
            return
        }
        of = e;
        const r = e.info.maxPlayerCount,
            s = t.slice(0, r);
        s.sort(this.playerTableOrderCompareFunc);
        for (let i = 0; i < r; i++) t[i] = s[i];
        of = null
    }}
function fy(n) {
    return n.outpostCountByType[pe.Generator] + n.outpostCountByType[pe.Factory]
}
function _2e(n, e) {
    const t = te.teamFirstSeat(n.info, e),
        r = te.teamEndSeat(n.info, e);
    for (let s = t; s < r; s++)
        if (n.playerStates.get(s).timeOfDeathInSecs < 0) return s;
    return r > t ? t : -1
}
function $2e(n, e) {
    const t = n.info,
        r = te.teamCount(t),
        s = t.noMines ? te.getOutpostGoal(t) : t.neptuniumGoal,
        i = l => {
            e != null && (e.playerIndex = _2e(n, l))
        };
    let a = 0,
        o = -1;
    for (let l = 0; l < r; l++) {
        if (!ut.isTeamAlive(n, l)) continue;
        if (a++, o = l, (t.noMines ? ut.getTeamOutpostCount(n, l) : ut.getTeamNeptunium(n, l)) >= s) return i(l), !0
    }
    return a <= 1 ? (i(o), !0) : !1
}
export function originalStandings(n){const order=[],teams=[],ranks=[],winners=[];ut.calculatePlayerTableOrder(n,order);ut.calculateTeamOrder(n,teams);ut.getTeamRankBySeat(n,ranks);ut.getWinningPlayers(n,winners);return {order:order.filter(i=>i>=0),teams:teams.filter(i=>i>=0),teamRanks:ranks.slice(0,n.info.maxPlayerCount),winners:winners.filter(i=>i>=0)};}
export function originalGameOver(n){const result={playerIndex:-1};const ended=ut.isGameOver(n,result);return {ended,player:result.playerIndex,team:result.playerIndex<0||!te.hasTeams(n.info)?-1:te.teamOf(n.info,result.playerIndex)};}
