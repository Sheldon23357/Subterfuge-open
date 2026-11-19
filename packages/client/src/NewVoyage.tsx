import React, {useEffect,useState} from 'react';
import { Anchor, ArrowRight, Dices, User, X } from 'lucide-react';
import {type MatchCreation} from '../../contracts/src/index.js';

interface Props {
  players: number;
  seed: number;
  busy: boolean;
  error: string;
  setPlayers: (value: number) => void;
  setSeed: (value: number) => void;
  close: () => void;
  create: (bindings: {seat:number;slot:number}[]) => Promise<void>;
  rules:MatchCreation;
  setRules:(value:MatchCreation)=>void;
  startMode:'fresh'|'endgame';
  setStartMode:(value:'fresh'|'endgame')=>void;
}

export function NewVoyage({players,seed,busy,error,setPlayers,setSeed,close,create,rules,setRules,startMode,setStartMode}: Props) {
  const validSeed=Number.isInteger(seed)&&seed>=0&&seed<=4294966796;
  const [seats,setSeats]=useState(()=>Array.from({length:10},(_,i)=>({mode:i<players?'manual':'off',slot:-1})));
  const [controller,setController]=useState<{available:boolean;slots:{slot:number;id:string;provider:string;model:string}[]}>({available:false,slots:[]});
  useEffect(()=>{const abort=new AbortController();const read=()=>void fetch('/api/ai-controller',{signal:abort.signal,cache:'no-store'}).then(r=>r.ok?r.json():Promise.reject()).then(value=>{if(!abort.signal.aborted)setController(value);}).catch(()=>{if(!abort.signal.aborted)setController({available:false,slots:[]});});read();const timer=setInterval(read,3000);return()=>{abort.abort();clearInterval(timer);};},[]);
  const active=seats.filter(s=>s.mode!=='off');
  const missingBinding=active.some(s=>s.mode==='ai'&&(s.slot<0||!controller.available));
  const bindings=active.flatMap((s,seat)=>s.mode==='ai'?[{seat,slot:s.slot}]:[]);
  function updateSeat(index:number,patch:Partial<typeof seats[number]>){if(patch.mode&&patch.mode!=='ai')patch={...patch,slot:-1};const next=seats.map((s,i)=>i===index?{...s,...patch}:s);setSeats(next);setPlayers(next.filter(s=>s.mode!=='off').length);}
  return <div className="voyage-layout" aria-busy={busy}>
    <img className="voyage-art" src="/assets/departure/deep-sea-departure.png" alt="" />
    <button className="voyage-close" autoFocus onClick={close} disabled={busy} aria-label="关闭弹窗"><X size={20}/></button>
    <div className="voyage-brand"><Anchor size={20}/><span>ABYSSAL<span className="voyage-brand-divider">/</span>深潜</span></div>
    <section className="voyage-scene" aria-label="航行简报">
      <div className="voyage-title">
        <p><span/>舰队部署</p>
        <h2>新的海域，<br/>由你掌控。</h2>
        <span className="voyage-title-caption">开始新的航行</span>
      </div>
    </section>
    <form className="voyage-console" onSubmit={e=>{e.preventDefault();if(validSeed&&active.length>=2&&!missingBinding&&!busy)void create(bindings);}}>

      <fieldset className="voyage-controls" disabled={busy}>
        <section className="voyage-roster" aria-label="席位配置">
          <header><span>席位配置</span><span>{active.length} 人</span></header>
          <div className="voyage-seat-list">
          {seats.map((s,index)=>{
            return <React.Fragment key={index}>
              <div className={`voyage-seat-row${s.mode==='off'?' is-off':''}`}>
                <User size={15}/><span>{String(index+1).padStart(2,'0')}{index===0&&s.mode==='manual'?' · 你':''}</span>
                <div className="voyage-seat-modes" role="group" aria-label={`席位 ${index+1} 控制方式`}>
                  {([['off','关闭'],['manual','手动'],['ai','AI']] as const).map(([mode,label])=><button type="button" key={mode} aria-pressed={s.mode===mode} disabled={index===0&&mode==='off'||mode==='ai'&&!controller.available} onClick={()=>updateSeat(index,{mode})}>{label}</button>)}
                </div>
                {s.mode==='ai'?<select className="voyage-ai-binding" aria-label={`席位 ${index+1} 绑定 AI`} required value={s.slot} onChange={e=>updateSeat(index,{slot:Number(e.target.value)})}><option value={-1}>选择控制器 AI</option>{controller.slots.map(slot=><option key={slot.slot} value={slot.slot} disabled={seats.some((other,i)=>i!==index&&other.mode==='ai'&&other.slot===slot.slot)}>AI {String(slot.slot+1).padStart(2,'0')}{slot.model?' · '+slot.model:''}</option>)}</select>:<span className="voyage-seat-hint">{s.mode==='off'?'不参与本局':index===0?'你的指挥席位':'手动控制'}</span>}
              </div>

            </React.Fragment>;
          })}
          </div>
          <p>关闭的席位不入局。每个 AI 席位只能绑定一次，绑定后在控制器中启动。</p>
          {active.length<2&&<p className="voyage-error" role="status">至少开启 2 个席位。</p>}
        </section>
        <div className="voyage-field">
          <label className="voyage-label" htmlFor="voyage-seed">地图种子</label>
          <div className="voyage-seed-control">
            <span aria-hidden="true">#</span>
            <input id="voyage-seed" type="number" min={0} max={4294966796} step={1} value={Number.isFinite(seed)?seed:''} onChange={e=>setSeed(e.target.valueAsNumber)} aria-invalid={!validSeed} aria-describedby={!validSeed?'voyage-seed-error':undefined} required/>
            <button type="button" aria-label="随机地图种子" title="随机地图种子" onClick={()=>setSeed(crypto.getRandomValues(new Uint32Array(1))[0]!%4294966797)}><Dices size={19}/></button>
          </div>
          {!validSeed&&<p id="voyage-seed-error" className="voyage-error">请输入 0 至 4294966796 的整数。</p>}
        </div>
        <div className="voyage-world-info"><span>数量优先海域</span><strong>{players*10} <small>处据点</small></strong></div>
        <details className="voyage-rules"><summary>对局规则 · {startMode==='endgame'?'随机残局':'新航行'} · {rules.mode==='mining'?'采矿':'统治'} · 个人</summary>
          <div className="voyage-rule-fields"><label htmlFor="start-mode">开局方式<select id="start-mode" value={startMode} onChange={e=>setStartMode(e.target.value as 'fresh'|'endgame')}><option value="fresh">全新航行</option><option value="endgame">固定残局（按种子随机）</option></select></label><label htmlFor="victory-mode">胜利条件<select id="victory-mode" value={rules.mode} onChange={e=>setRules({...rules,mode:e.target.value as MatchCreation['mode']})}><option value="mining">采矿</option><option value="domination">统治（禁止开矿）</option></select></label>
          {rules.mode==='mining'&&<label htmlFor="neptunium-goal">目标矿量（kg）<input id="neptunium-goal" type="number" min={1} max={100000} step={1} required value={rules.neptuniumGoal} onChange={e=>setRules({...rules,neptuniumGoal:e.target.valueAsNumber})}/></label>}
          </div>
        </details>
      </fieldset>
      <div className="voyage-launch">
        {error&&<p className="voyage-error" role="alert">{error}</p>}
        <button className="voyage-launch-button" type="submit" disabled={busy||!validSeed||active.length<2||missingBinding}>
          <span>{busy?'正在生成海域…':'启航'}</span><ArrowRight size={22}/>
        </button>
      </div>
    </form>
  </div>;
}
