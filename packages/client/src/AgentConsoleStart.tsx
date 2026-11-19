import React from 'react';
import {ArrowRight,Check,Link2,Play,Settings2,Unplug,Anchor} from 'lucide-react';

export function AgentConsoleStart({bound,connected,canStart,canConnect,model,onStart,onConfigure,onConnect}:{bound:boolean;connected:boolean;canStart:boolean;canConnect:boolean;model:string;onStart:()=>void;onConfigure:()=>void;onConnect:()=>void}){
 if(!bound)return <section className="console-start start-launch" aria-label="开始运行">
  <div className="launch-hero">
   <div className="launch-copy"><span className="launch-status"><i/>席位待命 · 尚未连接</span><span className="launch-emblem" aria-hidden="true"><Anchor size={28} strokeWidth={1.3}/></span><h2>连接你的 AI 席位</h2><p>为 AI 选择一个游戏席位。连接后配置决策方式，准备好后再启动。</p>
    <div className="start-actions"><button type="button" className="console-primary" disabled={!connected||!canConnect} onClick={onConnect}><Link2 size={16}/>连接游戏</button><button type="button" onClick={onConfigure}><Settings2 size={15}/>配置席位<ArrowRight size={14}/></button></div>
    {!connected&&<p className="start-connection" role="status">运行器连接中断，恢复连接后可继续。</p>}
    {!canConnect&&<p className="start-connection">请在启动配置中设置游戏连接。</p>}
   </div>
  </div>
  <div className="launch-guide"><section className="launch-connection"><h3>接入步骤</h3><ol className="launch-steps">
   <li><span>01</span><div><h4>选择席位</h4><p>打开大厅并加入房间，在自己的席位或空位点击“绑定 bot”，再选择 bot 槽位并确认。</p></div></li>
   <li><span>02</span><div><h4>配置决策</h4><p>选择模型来源、决策风格与战术参数。<small>当前：{model}</small></p></div></li>
   <li><span>03</span><div><h4>手动启动</h4><p>确认配置后点击“启动 AI”，在实时面板查看搜索、方案与执行结果。</p></div></li>
  </ol></section><aside className="launch-rules" aria-label="运行规则"><h3>运行规则</h3><dl>
   <div><dt>连接后保持暂停</dt><dd>连接只绑定席位，由你决定何时启动。</dd></div>
   <div><dt>模型配置可选</dt><dd>不配置模型时，程序仍可自主决策。</dd></div>
   <div><dt>运行器需保持开启</dt><dd>关闭网页不会停止 AI；需要停止时，请在控制台暂停。</dd></div>
  </dl></aside></div>
 </section>;
 return <section className="console-start start-ready" aria-label="开始运行">
  <div className="ready-deck">
   <div className="ready-intro">
    <span className="ready-status" data-connected={connected}><i/>{connected?'已绑定 · 待启动':'连接中断'}</span>
    <div className="ready-copy"><h2>开始本次运行</h2><p>启动后，AI 将分析当前局势，进行战术搜索并执行行动。</p></div>
    <div className="start-actions ready-actions"><button type="button" className="console-primary" disabled={!connected||!canStart} onClick={onStart}><Play size={17}/>启动 AI</button><button type="button" onClick={onConfigure}><Settings2 size={16}/>配置席位<ArrowRight size={14}/></button></div>
    {!connected&&<p className="start-connection" role="status">运行器连接中断，恢复连接后可启动。</p>}
   </div>
   <div className="ready-overview">
    <h3 className="ready-overview-title">运行准备</h3>
    <ol className="ready-checklist">
     <li><span className="ready-step" data-ready="true"><Check size={19}/></span><div><h3>游戏连接</h3><p>当前席位已绑定游戏</p></div><span className="ready-tag">已连接</span></li>
     <li><span className="ready-step" data-ready="true"><Settings2 size={19}/></span><div><h3>决策配置</h3><p>{model}</p></div><button type="button" onClick={onConfigure} aria-label="调整决策配置"><ArrowRight size={17}/></button></li>
     <li><span className="ready-step"><Unplug size={19}/></span><div><h3>实时运转</h3><p>启动后查看搜索、方案与执行记录</p></div><span className="ready-idle">未开始</span></li>
    </ol>
   </div>
  </div>
 </section>;
}
