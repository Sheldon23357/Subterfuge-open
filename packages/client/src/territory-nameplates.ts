import {colors,playerNames} from './theme.js';
import type {AiMapStatus} from './AiStatusStrip.js';
type Center={owner:number;position:{x:number;y:number}};
export function drawTerritoryNameplates(ctx:CanvasRenderingContext2D,centers:Center[],world:{width:number;height:number},screen:{width:number;height:number;cx:number;cy:number;scale:number},status:AiMapStatus,time:number,motion:boolean){
  ctx.save();ctx.font='600 16px "Abyss Cabin", "DengXian", sans-serif';ctx.textAlign='left';ctx.textBaseline='middle';
  for(const center of centers){
    const name=playerNames[center.owner]??`玩家 ${center.owner+1}`,nameWidth=ctx.measureText(name).width,width=Math.max(99,nameWidth+63)*1.5*.7*.75,height=31.5;
    const color=colors[center.owner]??'#859da8';
    const rgb=[1,3,5].map(i=>Math.round(parseInt(color.slice(i,i+2),16)*.85+255*.15));
    const ai=status.seats.find(s=>s.seat===center.owner),thinking=!status.unavailable&&ai?.enabled&&ai.status==='thinking';
    const baseX=screen.cx+center.position.x*screen.scale,baseY=screen.cy+center.position.y*screen.scale;
    const worldW=world.width*screen.scale,worldH=world.height*screen.scale;
    if(!(worldW>0&&worldH>0))continue;
    for(let ox=Math.ceil((-width-baseX)/worldW);ox<=Math.floor((screen.width+width-baseX)/worldW);ox++)
      for(let oy=Math.ceil((-height-baseY)/worldH);oy<=Math.floor((screen.height+height-baseY)/worldH);oy++){
        const px=baseX+ox*worldW,py=baseY+oy*worldH;
        ctx.globalAlpha=1;ctx.fillStyle=`rgba(${rgb.join(',')},0.4)`;ctx.strokeStyle='#fffffff0';ctx.lineWidth=2.5;
        ctx.shadowColor='#06141b80';ctx.shadowBlur=10;ctx.shadowOffsetY=2;
        ctx.beginPath();ctx.roundRect(px-width/2,py-height/2,width,height,height/2);ctx.fill();ctx.shadowColor='transparent';ctx.stroke();
        const dotX=px-(nameWidth+27)/2+5.25;
        ctx.globalAlpha=thinking&&motion?0.45+0.55*(.5+.5*Math.cos(time/350)):1;
        ctx.strokeStyle=color;ctx.fillStyle=color;ctx.lineWidth=2.25;ctx.beginPath();ctx.arc(dotX,py,5.25,0,Math.PI*2);
        if(thinking)ctx.fill();else ctx.stroke();
        ctx.globalAlpha=1;ctx.fillStyle='#fff';ctx.fillText(name,dotX+16.5,py+.75);
      }
  }
  ctx.restore();
}
