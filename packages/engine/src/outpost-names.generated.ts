// @ts-nocheck
// Verbatim APK 12075 naming excerpts; regenerate with scripts/extract-outpost-names.mjs.
// SHA256 41a81d2529b71de38016cff949fb9731b858869d274ecb4aa179231231c02bd1
const Z=(value)=>{if(!value)throw Error('Original naming assertion');};
const K={MaxOutpostCount:100};
const MPe = 32767;

function I3(n, e, t) {
    return n + t * (e - n)
}

class p0 {
    m_next;
    m_stubsRemaining;
    m_stubs = new Array(16);
    constructor() {
        this.reset()
    }
    reset() {
        this.m_next = BigInt(1), this.m_stubsRemaining = 0
    }
    setSeed(e) {
        this.m_next = BigInt(e)
    }
    getFloat(e, t) {
        if (Z(e <= t), this.m_stubsRemaining > 0) return --this.m_stubsRemaining, I3(e, t, this.m_stubs[this.m_stubsRemaining]);
        {
            const r = this.customRand(),
                s = Math.fround(r / MPe);
            return I3(e, t, s)
        }
    }
    getFloatFromRange(e) {
        return this.getFloat(e.min, e.max)
    }
    getInt(e, t) {
        if (Z(e <= t), this.m_stubsRemaining > 0) {
            --this.m_stubsRemaining;
            const r = Math.fround(this.m_stubs[this.m_stubsRemaining]),
                s = I3(e, t + 1, r);
            return Math.min(s, t)
        } else return this.customRand() % (t - e + 1) + e
    }
    stubPercentages(e, t) {
        Z(t > 0);
        for (let r = 0; r < t; ++r) this.m_stubs[t - r - 1] = e[r];
        this.m_stubsRemaining = t
    }
    customRand() {
        return this.m_next = (this.m_next * BigInt(1103515245) & BigInt(4294967295)) + BigInt(12345) & BigInt(4294967295), Number(this.m_next >> BigInt(16) & BigInt(32767))
    }
}

const mX = ["KYBURZ", "CALHAMER", "VACCARINO", "VINTGAR", "SIVAN", "AUSICH", "HELLMAN", "WOHLWEND", "GARFIELD", "ADRIA", "VERNE", "FELD", "WALLACE", "KRAMER", "KIESLING", "ISAKSEN", "SHANEVILLE", "SAMET", "BAHAT", "SMITHRAND", "MCGUIRE", "ALBREED", "SALTMINE", "DEJONGH", "BOXLIGHTER", "GABLER", "CLARKRYE", "SOREN", "RUIZ", "GOSS", "HAGAI", "TAMIR", "TOMETZ", "BILLANTE", "CEBU", "SHASTA", "SEABASS", "NAIJA", "POTECA", "CHONGOS", "HUMBLEROD", "TIBERIUS", "ADAMA", "NAUTILUS", "COUSTEAU", "WOODRIDGE", "OAKTOWN", "KAI-CHAN", "BENTHIC", "SERENITY", "ROKOVOKO", "SAGAN", "SSAM-BAR", "EL-FAROLITO", "TRITON", "LIR", "MAZU", "DAKUWAQA", "AHTI", "POSEIDON", "PROTEUS", "KANALOA", "VARUNA", "PARICIA", "SEDNA", "SUIJIN", "TANGAROA", "ENKI", "RAN", "HAIK", "NEPTUNE", "FATE", "CHAMPINO", "RAVEN", "CONGO", "SOLO", "STELLA", "TYRION", "FAM", "NEMO", "AHAB", "HOOK", "ROBERTS", "MAGELLAN", "PHILLIPS", "WILKES", "HASHIMOTO", "OCTOBER", "GOTENGO", "DEEPCORE", "YAMATO", "THUNDERBIRD", "SUUKYI", "MANDELA", "KING", "GANDHI", "DONATU", "ARCHANIS", "HATORIA", "MARANGA", "STUTTGART", "LYDIMIRR", "WATSON", "GABOTO", "LYRA", "CHILLI", "SEGNO", "RESPITE", "VOID"];

const HG = [{
        from: 1787328e3,
        size: 109
    }];

const Q1 = K.MaxOutpostCount;

const E2e = 1597676577;

function Ane(n, e = HG) {
    let t = null;
    for (const r of e) n >= r.from && (t === null || r.from >= t.from) && (t = r);
    return t
}

function JG(n) {
    const e = new Set(n.retired ?? []),
        t = [];
    for (let r = 0; r < n.size; r++) e.has(r) || t.push(r);
    return t
}

function yne(n, e) {
    const t = JG(e),
        r = new p0;
    r.setSeed((n ^ E2e) >>> 0);
    for (let s = 0; s < Q1; s++) {
        const i = r.getInt(s, t.length - 1),
            a = t[s];
        t[s] = t[i], t[i] = a
    }
    return t.slice(0, Q1)
}

/** Current pool by default; historical creation timestamps retain original positional names. */
export function originalOutpostNames(seed:number,count:number,createdAt:number=HG[HG.length-1].from):string[]{
 if(!Number.isInteger(seed)||seed<0||seed>0xffffffff)throw new RangeError('Invalid name seed');
 if(!Number.isInteger(count)||count<0||count>K.MaxOutpostCount)throw new RangeError('Invalid outpost count');
 const epoch=Ane(createdAt);
 const indices=epoch&&JG(epoch).length>=Q1?yne(seed,epoch):Array.from({length:Q1},(_,i)=>i);
 return indices.slice(0,count).map(i=>mX[i]);
}
