/** Keep a small help surface inside the viewport, preferring below its trigger. */
export function tipPosition(anchor:{left:number;bottom:number;top:number;right?:number},viewport:{width:number;height:number},height:number,preferSide=false){
  const margin=12,width=Math.max(0,Math.min(320,viewport.width-margin*2));
  const maxHeight=Math.max(0,viewport.height-margin*2);
  const visibleHeight=Math.min(height,maxHeight);
  if(preferSide&&anchor.right!==undefined){
    const right=anchor.right+10,left=anchor.left-width-10;
    const side=right+width<=viewport.width-margin?right:left>=margin?left:null;
    if(side!==null)return {left:side,top:Math.max(margin,Math.min(anchor.top-16,viewport.height-margin-visibleHeight)),width,maxHeight};
  }
  const below=anchor.bottom+8;
  const top=below+visibleHeight<=viewport.height-margin?below:Math.max(margin,anchor.top-visibleHeight-8);
  return {left:Math.max(margin,Math.min(anchor.left,viewport.width-width-margin)),top,width,maxHeight};
}
