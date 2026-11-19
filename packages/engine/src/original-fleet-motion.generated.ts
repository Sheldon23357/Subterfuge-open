// @ts-nocheck
// Exact APK12075 ZD/MH and vector methods. Do not format. SHA256 41a81d2529b71de38016cff949fb9731b858869d274ecb4aa179231231c02bd1
import {RULES} from '../../rules/src/reference-profile.js';
import {CLIENT_EPSILON,unwrapClientPoint,wrapClientPoint} from './client-geometry.js';
const he=RULES.GameParams,Zn=CLIENT_EPSILON,K={MinutesPerTick:10};
const B={Outpost:1,Sub:2},He={Moving:'moving',Arriving:'arriving',Launching:'launching'};
const Z=c=>{if(!c)throw Error('Original movement assertion');};
class Hc{}
class G extends Hc{static clone(e) {
        return new G(e.x, e.y)
    }
static copy(e, t) {
        return e.x = t.x, e.y = t.y, e
    }
static add(e, t, r) {
        return e.x = t.x + r.x, e.y = t.y + r.y, e
    }
static subtract(e, t, r) {
        return e.x = t.x - r.x, e.y = t.y - r.y, e
    }
static multiplyScalar(e, t, r) {
        return e.x = t.x * r, e.y = t.y * r, e
    }
constructor(e, t) {
        super(), typeof e == "object" ? (this.x = e.x, this.y = e.y) : (this.x = e || 0, this.y = t || 0)
    }
clone() {
        return new G(this.x, this.y)
    }
add(e) {
        return this.x += e.x, this.y += e.y, this
    }
subtract(e) {
        return this.x -= e.x, this.y -= e.y, this
    }
multiplyScalar(e) {
        return typeof e == "object" && console.warn("should use Vec2.multiply for vector * vector operation"), this.x *= e, this.y *= e, this
    }
divide2f(e, t) {
        return this.x /= e, this.y /= t, this
    }
length() {
        return Math.sqrt(this.x * this.x + this.y * this.y)
    }}
class fp {
    a;
    b;
    constructor(e = new G, t = new G) {
        this.a = e, this.b = t
    }
}
const na=new G();
const vec=p=>new G(p.x,p.y);
const V={
 getSubCurrentPosToDest:w=>vec(w.pursuit?w.target:unwrapClientPoint(w.target,w.sub.pos,w)).subtract(w.sub.pos),
 getSubSpeed:w=>w.speed,
 getItemPosition:w=>vec(w.target),
 getUnwrappedPos:(w,p,anchor)=>vec(unwrapClientPoint(p,anchor,w)),
 getWrappedPos:(width,height,p)=>vec(wrapClientPoint(p,{width,height})),
};
function ZD(n, e, t) {
    const r = n.subs.get(e),
        s = V.getSubCurrentPosToDest(n, e);
    G.add(r.trueDestPos, r.pos, s);
    const i = s.length(),
        a = V.getSubSpeed(n, e),
        o = t * a * K.MinutesPerTick;
    if (r.heading = Math.atan2(s.y, s.x) - Math.PI / 2, i <= o && r.destination.type == B.Outpost) {
        const l = V.getItemPosition(n, r.destination);
        G.copy(r.pos, l), r.state = He.Arriving, r.fractionMoved = i / o, G.copy(r.lastSunkAt, r.pos)
    } else if (i > Zn) {
        const l = s.clone().divide2f(i, i),
            c = r.pos.clone().add(l.multiplyScalar(o));
        r.pos = V.getWrappedPos(n.width, n.height, c), r.fractionMoved = 1
    } else r.pos = V.getItemPosition(n, r.destination), r.fractionMoved = 0
}
function MH(n, e, t) {
    const r = n.subs.get(e);
    Z(r.used);
    let s = V.getUnwrappedPos(n, r.prevPos, t),
        i = V.getUnwrappedPos(n, r.pos, t);
    if (r.state == He.Arriving || r.state == He.Launching) {
        if (r.fractionMoved < 1) {
            const o = G.subtract(na, i, s).length();
            if (o > Zn) {
                const l = i.clone().subtract(s).divide2f(o, o);
                switch (r.state) {
                    case He.Arriving:
                        G.add(i, s, G.multiplyScalar(na, l, o / r.fractionMoved));
                        break;
                    case He.Launching:
                        G.subtract(s, i, G.multiplyScalar(na, l, o * r.fractionMoved));
                        break
                }
            }
        } else if (he.RulesVersion > 35) {
            const o = V.getSubCurrentPosToDest(n, e),
                l = o.length(),
                u = 1 * V.getSubSpeed(n, e) * K.MinutesPerTick;
            let d = 1;
            l <= u && r.destination.type == B.Outpost && (d = l / u);
            const h = he.RulesVersion > 36 ? u / d : d;
            switch (r.state) {
                case He.Arriving:
                    G.subtract(s, i, G.multiplyScalar(na, o.divide2f(l, l), h));
                    break;
                case He.Launching:
                    G.add(i, s, G.multiplyScalar(na, o.divide2f(l, l), h));
                    break
            }
        }
    }
    return new fp(s, i)
}
function context(f,target,size,speed,pursuit){
 const sub={used:true,pos:vec(f.position),prevPos:vec(f.previous),state:f.state,fractionMoved:f.fractionMoved,
 trueDestPos:new G(),lastSunkAt:new G(),destination:{type:pursuit?B.Sub:B.Outpost}};
 return {...size,target,speed,pursuit,sub,subs:{get:()=>sub}};
}
export function originalMoveFleet(f,target,size,speed,fraction,pursuit){
 const w=context(f,target,size,speed,pursuit);ZD(w,0,fraction);
 f.position={x:w.sub.pos.x,y:w.sub.pos.y};f.state=w.sub.state;f.fractionMoved=w.sub.fractionMoved;
}
export function originalFleetSegment(f,target,anchor,size,speed,pursuit=false){
 const w=context(f,target,size,speed,pursuit),segment=MH(w,0,anchor);
 return {a:{x:segment.a.x,y:segment.a.y},b:{x:segment.b.x,y:segment.b.y}};
}
