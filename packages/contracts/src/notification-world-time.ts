/** Display-only interpretation of verified captureRuleNotification records
 * (including PlayerNotification and rule forecast notifications). The caller
 * must establish that provenance; kind/tick/seconds alone cannot distinguish a
 * rule notification from an activity log, command, observation or old archive.
 * In particular, activity-capture already normalizes movement ticks. */
export interface RuleNotificationWorldTime {
  eventWorldDay:number|null;
  eventTimeBasis:'settlement-tick-interval'|'tick-phase'|'unknown';
  eventTimePrecision:'rounded-rule-second'|'unknown';
}

// These notifications are emitted during movement after the economy advances
// its tick. Their seconds describe the interval ending at that settlement tick.
const movementKinds=new Set(['departed','battle','mine-captured','dormant-arrival']);
// Each of these capture sites uses the current state phase (usually zero for
// tick-driven events). Elimination/game end do not inherit battle fractions.
const phaseKinds=new Set([
  'player-eliminated','game-ended','mine-created','funding-toggled',
  'funding-expired','inactivity-warning','player-resigned',
]);

export function ruleNotificationWorldTime(value:{kind?:unknown;tick?:unknown;seconds?:unknown}):RuleNotificationWorldTime {
  const unknown:RuleNotificationWorldTime={eventWorldDay:null,eventTimeBasis:'unknown',eventTimePrecision:'unknown'};
  const {kind,tick,seconds}=value;
  if(typeof kind!=='string'||typeof tick!=='number'||!Number.isSafeInteger(tick)||tick<0||
    typeof seconds!=='number'||!Number.isInteger(seconds)||seconds<0)return unknown;
  const movement=movementKinds.has(kind);
  if(movement ? tick<1||seconds>600 : !phaseKinds.has(kind)||seconds>=600)return unknown;
  return {
    eventWorldDay:tick-(movement?1:0)+seconds/600,
    eventTimeBasis:movement?'settlement-tick-interval':'tick-phase',
    // captureRuleNotification uses Math.round(fraction * 600). This is not the
    // original unrounded movement event fraction or an exact arrival estimate.
    eventTimePrecision:'rounded-rule-second',
  };
}
