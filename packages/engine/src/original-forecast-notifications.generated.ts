// @ts-nocheck
// Exact APK12075 Pc.handleEvent, sonar per-player block and FOe. SHA256 41a81d2529b71de38016cff949fb9731b858869d274ecb4aa179231231c02bd1
// Regenerate with node scripts/extract-forecast-notifications.mjs.
import {SPECIALISTS} from '../../rules/src/reference.js';
const B={Nothing:0,Sub:2},rt={Visible:2},He={WaitingForLaunch:'waiting',Moving:'moving'},ke={Ended:'ended'},yn={Normal:'normal'},K={SecondsPerTick:600};
class G{constructor(x,y){this.x=x;this.y=y;}}
class we{constructor(type,index){this.type=type;this.index=index;}}
const Z=c=>{if(!c)throw Error('Original forecast notification assertion');};
const ct={add:(a,v)=>a.push(v)};
class BoundedEvents{static add(e, t) {
        Z(e.count < e.capacity), e.count < e.capacity && (e.elements[e.count++] = t)
    }}
export function originalAppendForecastEvent(queue,event){BoundedEvents.add(queue,event);}
const V={getItemPosition:(w,l)=>({...w.subs.get(l.index).pos})};
const te={getScreenName:(info,i)=>info.names[i]};
const kt=Object.fromEntries(SPECIALISTS.map(s=>[s.client_type_id,{name:s.name_en}]));
const list=values=>({count:values.length,get:i=>values[i],clone:()=>list([...values])});
const wn={compute:(a,w)=>{a.subs=list(w.nextVisibility);}};
class qD {
    sendNotification;
    playerIndex;
    minutesBeforeSending;
    locationType;
    locationIndex;
    tick;
    text = "";
    details = "";
    pos;
    flavor;
    generateAlert;
    attack;
    creationTime;
    constructor() {
        this.sendNotification = !0, this.playerIndex = 1e4, this.tick = -1, this.minutesBeforeSending = 0, this.locationType = B.Nothing, this.locationIndex = -1, this.creationTime = -1, this.pos = new G(0, 0), this.flavor = 1, this.generateAlert = !0
    }
}
function FOe(n, e, t) {
    if (Z(e.used), e.ownerIndex >= 0 ? n.string += `A sub of ${te.getScreenName(t.info,e.ownerIndex,!0)}'s ` : n.string += "A dormant sub ", n.string += `carrying ${e.drillers} drillers `, e.specialistCache.count > 1) n.string += `and ${e.specialistCache.count} specialists `;
    else if (e.specialistCache.count == 1) {
        const r = e.specialistCache.get(0),
            s = t.world.specialists.get(r),
            i = kt[s.type];
        n.string += `and a ${i.name} `
    }
    n.string += "just appeared on your sonar."
}
class Notifications{
 handleEvent(e, t, r, s, i, a, o, l, c = !0, u) {
        if (e.status != ke.Ended && e.playerStates.get(t).timeOfDeathInSecs >= 0) return;
        let d = new qD;
        if (d.playerIndex = t, d.flavor = l, this.immediateSendingMode) d.minutesBeforeSending = 0;
        else {
            const h = (e.tickCount - this.startingTickCount) * K.SecondsPerTick - this.secondsSinceLastTick,
                p = e.timeFactor * h;
            if (p < 0) return;
            d.minutesBeforeSending = Math.trunc(p / 60) + 1
        }
        d.locationType = r, d.locationIndex = s, d.sendNotification = o, d.generateAlert = c, a && a != null && (d.details = a), r != B.Nothing && (d.pos = V.getItemPosition(e.world, new we(r, s))), d.text = i, ct.add(this.gameEvents, d)
    }
 scan(Ml,i){this.world=Ml.world;
                let a = this.visibility[i],
                    o = a.subs.clone();
                wn.compute(a, this.world, i, this.world);
                let l = -1,
                    c = !1;
                for (let u = 0; u < this.world.subs.count; ++u) {
                    const d = this.world.subs.get(u);
                    if (!(!d.used || d.ownerIndex == i) && o.get(u) != rt.Visible && a.subs.get(u) == rt.Visible && d.state != He.WaitingForLaunch) {
                        if (l != -1) {
                            c = !0;
                            break
                        }
                        l = u
                    }
                }
                if (l >= 0)
                    if (c) this.handleEvent(Ml, i, B.Sub, l, "Multiple subs just appeared on your sonar.", null, !0, yn.Normal, !1);
                    else {
                        const u = this.world.subs.get(l);
                        if (u.ownerIndex != i && u.state == He.Moving && (u.drillers >= 10 || u.specialistCache.count > 0)) {
                            let d = {
                                string: ""
                            };
                            FOe(d, u, Ml), this.handleEvent(Ml, i, B.Sub, l, d.string, null, !0, yn.Normal, !1)
                        }
                    }
            }
}
/** Data adapter; callers must provide only their permitted forecast entities. */
export function originalForecastSonarNotifications(input){
 const n=new Notifications();n.gameEvents=[];n.startingTickCount=input.startTick;n.secondsSinceLastTick=input.observedSeconds;n.immediateSendingMode=false;
 n.visibility=[];n.visibility[input.player]={subs:list(input.previousVisibility)};
 const state={tickCount:input.tick,timeFactor:input.timeFactor??1,status:input.ended?'ended':'in-progress',
  info:{names:input.names},playerStates:{get:()=>({timeOfDeathInSecs:input.deathSeconds??-1})},
  world:{subs:list(input.fleets.map(f=>({...f,specialistCache:list(f.specialists)}))),specialists:list(input.specialists),nextVisibility:input.visibility}};
 n.scan(state,input.player);return n.gameEvents;
}
export function originalForecastEventMinutes(startTick,observedSeconds,tick){
 const n=new Notifications();n.gameEvents=[];n.startingTickCount=startTick;n.secondsSinceLastTick=observedSeconds;n.immediateSendingMode=false;
 n.handleEvent({tickCount:tick,timeFactor:1,status:'in-progress',playerStates:{get:()=>({timeOfDeathInSecs:-1})}},0,B.Nothing,-1,'',null,true,yn.Normal);
 return n.gameEvents[0]?.minutesBeforeSending??null;
}
