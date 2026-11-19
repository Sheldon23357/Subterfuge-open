// @ts-nocheck
// Verbatim APK12075 time-dependent getters. Do not format. SHA256 41a81d2529b71de38016cff949fb9731b858869d274ecb4aa179231231c02bd1
import {RULES} from '../../rules/src/reference-profile.js';
const he=RULES.GameParams,pe={Mine:0},He={WaitingForLaunch:'waiting',WaitingForCourseChange:'changing-course'};
class qn{static GetSecondsUntilShieldDisable(e, t) {
        return Math.max(e.secsUntilShieldDisable - Math.trunc(t), 0)
    }
static isMiningInProgress(e, t) {
        return he.RulesVersion >= 20 && e.private_secsUntilMineCreation == 0 ? !1 : Math.max(e.private_secsUntilMineCreation - Math.trunc(t), 0)
    }
static getType(e, t) {
        if (he.RulesVersion >= 20) {
            const r = e.private_secsUntilMineCreation > 0,
                s = e.private_secsUntilMineCreation < Math.trunc(t);
            if (r && s) return pe.Mine
        }
        return e.private_type
    }}
class Jt{static getSecondsUntilLaunch(e, t) {
        return e.state != He.WaitingForLaunch && e.state != He.WaitingForCourseChange ? 0 : e.secsUntilLaunch - Math.trunc(t)
    }
static isGift(e, t) {
        if (he.RulesVersion >= 20) {
            const r = e.secsUntilGifting > 0,
                s = e.secsUntilGifting < Math.trunc(t);
            return e.private_isGift || r && s
        } else return e.private_isGift
    }
static isBeingGifted(e, t) {
        return he.RulesVersion >= 20 && e.secsUntilGifting == 0 ? !1 : Math.max(e.secsUntilGifting - Math.trunc(t), 0) > 0
    }}
export const originalCommandTime={courseDelaySeconds:()=>he.MinutesToCancelAction * 60,shieldRemaining:qn.GetSecondsUntilShieldDisable,mining:qn.isMiningInProgress,outpostType:qn.getType,launchRemaining:Jt.getSecondsUntilLaunch,gift:Jt.isGift,gifting:Jt.isBeingGifted};
