import {RULES} from '../../rules/src/index.js';
import type {GameView} from './game-view.js';
/** Ordinary outposts share the same sonar radius. */
export function knownOutpostSonarRange(_view:GameView,_id:string):number{return RULES.OutpostParams.VisibilityRange;}
