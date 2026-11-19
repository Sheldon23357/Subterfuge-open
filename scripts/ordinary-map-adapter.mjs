/** Preserve the locked geometry algorithm while removing unit allocation from gameplay. */
export function ordinaryMapSource(reference) {
 const replacements=[
  ["import {RULES} from '../../rules/src/reference-profile.js';","import {RULES} from '../../rules/src/index.js';"],
  ['// Reviewed, verbatim APK 12075 excerpts. Regenerate with scripts/extract-map.mjs.','// Ordinary map geometry adapted from the locked APK excerpts. Regenerate with scripts/extract-map.mjs.'],
  [',MaxSpecialistsPerLocation:128',''],[",q={Queen:'Queen'},B={Outpost:1}",',B={Outpost:1}'],
  ['static addSpecialistCommitted(w,type,owner,location){w.queens.push({type,owner,outpost:location.index});}','static markStartingOutpost(w,owner,index){w.startingOutposts.push({owner,outpost:index});}'],
  [', this.specialistCache = new an(K.MaxSpecialistsPerLocation)',''],
  [', this.specialistCache = e.specialistCache.clone()',''],
  ['    specialistCache;',''],
  ['V.addSpecialistCommitted(n, q.Queen, d, new we(B.Outpost, p))','V.markStartingOutpost(n,d,p)'],
  ['Vn.QueenInitialDrillers','Vn.StartingOutpostInitialDrillers'],
  ['h < he.InitialOutpostsPerPlayer + 1','h < he.InitialOutpostsPerPlayer'],
  ['queens:[]','startingOutposts:[]'],['queens:w.queens','startingOutposts:w.startingOutposts'],
  ['export function originalCandidate(','export function ordinaryCandidate('],
 ];
 let result=reference;
 for(const [from,to]of replacements){if(!result.includes(from))throw Error(`Map adaptation source changed: ${from}`);result=result.replaceAll(from,to);}
 if(/specialist|queen|princess|recruitment/i.test(result))throw Error('Ordinary map retains specialist allocation');
 return result;
}
