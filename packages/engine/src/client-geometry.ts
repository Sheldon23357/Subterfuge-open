import type {Point,WorldSize} from './geometry.js';
/** Original Zn literal; squared-distance tests sometimes compare against this same epsilon. */
export const CLIENT_EPSILON=999999974e-13;
export interface Segment {a:Point;b:Point}
function point(p:Point){if(!Number.isFinite(p.x)||!Number.isFinite(p.y))throw new RangeError('Non-finite point');}
function size(w:WorldSize){if(!Number.isFinite(w.width)||!Number.isFinite(w.height)||w.width<=0||w.height<=0||w.width>80||w.height>80)throw new RangeError('Invalid client world dimensions');}
function centered(p:Point,w:WorldSize){point(p);size(w);if(Math.abs(p.x)>w.width/2+CLIENT_EPSILON||Math.abs(p.y)>w.height/2+CLIENT_EPSILON)throw new RangeError('Client point must use centered coordinates');}
function squared(a:Point,b:Point){const x=a.x-b.x,y=a.y-b.y;return x*x+y*y;}
/** Unwrap first point near anchor, only one image shift, as V.getUnwrappedPosWithDimensions. */
export function unwrapClientPoint(p:Point,anchor:Point,w:WorldSize):Point{
  point(p);point(anchor);size(w);
  const dx=p.x-anchor.x,dy=p.y-anchor.y,sx=dx>=0?1:-1,sy=dy>=0?1:-1;
  return{x:p.x+(sx*dx<=w.width/2?0:-sx*w.width),y:p.y+(sy*dy<=w.height/2?0:-sy*w.height)};
}
/** Preserve both +/-half endpoints. Do not replace this with Math.round canonicalization. */
export function wrapClientPoint(p:Point,w:WorldSize):Point{
  point(p);size(w);const result={...p};
  for(const [axis,extent]of [['x',w.width],['y',w.height]]as const){
    let steps=0;while(result[axis]>extent/2&&steps<10){result[axis]-=extent;steps++;}
    if(steps>=10)throw new RangeError('Client wrap exceeded ten shifts');
    steps=0;while(result[axis]<-extent/2&&steps<10){result[axis]+=extent;steps++;}
    if(steps>=10)throw new RangeError('Client wrap exceeded ten shifts');
  }
  return result;
}
export function clientDistanceSquared(a:Point,b:Point,w:WorldSize):number{
  centered(a,w);centered(b,w);return squared(unwrapClientPoint(a,b,w),b);
}
/** The length (not coordinates) rounds to Float32 before the original small-distance cutoff. */
export function clientDistance(a:Point,b:Point,w:WorldSize):number{
  centered(a,w);centered(b,w);
  const length=Math.fround(Math.sqrt(clientDistanceSquared(a,b,w))),value=length*length;
  return value<CLIENT_EPSILON?0:Math.sqrt(value);
}
function orientation(a:Point,b:Point,c:Point):number{
  const value=Math.round(((b.y-a.y)*(c.x-b.x)-(b.x-a.x)*(c.y-b.y))*1e8)/1e8;
  return Math.abs(value)<=CLIENT_EPSILON?0:value>0?1:2;
}
function onSegment(a:Point,b:Point,c:Point){return b.x<=Math.max(a.x,c.x)&&b.x>=Math.min(a.x,c.x)&&b.y<=Math.max(a.y,c.y)&&b.y>=Math.min(a.y,c.y);}
/** Literal Js.intersect predicate, including rounded orientation tolerance. */
export function clientSegmentsIntersect(a:Segment,b:Segment):boolean{
  for(const p of [a.a,a.b,b.a,b.b])point(p);
  const r=orientation(a.a,a.b,b.a),s=orientation(a.a,a.b,b.b),i=orientation(b.a,b.b,a.a),o=orientation(b.a,b.b,a.b);
  return r!==s&&i!==o||r===0&&onSegment(a.a,b.a,a.b)||s===0&&onSegment(a.a,b.b,a.b)||i===0&&onSegment(b.a,a.a,b.b)||o===0&&onSegment(b.a,a.b,b.b);
}
/** RH numerical calculation AFTER caller checks shared source/destination route and eligibility.
 * The original upper-bound guard reads the old zero fraction; preserve its absence here.
 */
export function clientRouteCollisionFraction(a:Segment,b:Segment):number|null{
  if(!clientSegmentsIntersect(a,b))return null;
  const dx=a.b.x-a.a.x,dy=a.b.y-a.a.y,length=Math.sqrt(dx*dx+dy*dy);
  if(length<CLIENT_EPSILON)return null;
  const ux=dx/length,uy=dy/length;
  const x=(b.a.x-a.a.x)*ux+(b.a.y-a.a.y)*uy,y=(b.b.x-a.a.x)*ux+(b.b.y-a.a.y)*uy;
  const divisor=length-y+x;
  if(Math.abs(divisor)<CLIENT_EPSILON)return null;
  const fraction=x/divisor;return fraction<0?null:fraction;
}
