"""Plot saved territory study; requires matplotlib."""
import json
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib import font_manager
root=Path(__file__).resolve().parents[1]
out=root/'artifacts/territory-priority-study'
r=json.loads((out/'results.json').read_text(encoding='utf-8'))
font=Path('C:/Windows/Fonts/msyh.ttc')
if font.exists():
    font_manager.fontManager.addfont(str(font))
    plt.rcParams['font.family']=font_manager.FontProperties(fname=str(font)).get_name()
plt.rcParams.update({'axes.unicode_minus':False,'font.size':10,'axes.spines.top':False,'axes.spines.right':False})
names={'original':'原版','geometryTie':'只保留领地差再优化距离','countGeometry':'完整数量分布优先','countSecure':'数量优先再考虑争夺余量'}
colors=['#777f89','#cd7946','#197d82','#5376ac']
fig,axs=plt.subplots(1,3,figsize=(14,4.8),layout='constrained')
g=r['groups']['fresh/5-10']['strategies']
for ax,(key,title)in zip(axs,[('belowMean','每局少于 10 个潜在据点的玩家数 ↓'),('variance','潜在领地数量方差 ↓'),('normalSecure20Min','每局最少的明显领先中立点数 ↑')]):
    values=[g[s]['metrics'][key]['mean'] for s in names]
    bars=ax.barh(list(names.values()),values,color=colors)
    ax.invert_yaxis();ax.set_title(title,fontsize=11);ax.grid(axis='x',alpha=.15);ax.set_axisbelow(True)
    ax.set_xlim(0,max(values)*1.25)
    for b,v in zip(bars,values):ax.text(v+max(values)*.025,b.get_y()+b.get_height()/2,f'{v:.3f}',va='center')
fig.suptitle('数量优先的筛选比较 · 全新 60 组窗口，5 至 10 人\n四种方案的原版领地差均值均为 1.500；争夺余量采用 20% 距离优势',fontsize=13)
fig.savefig(out/'quantity-comparison.png',dpi=160,bbox_inches='tight');fig.savefig(out/'quantity-comparison.svg',bbox_inches='tight');plt.close(fig)
fig,axs=plt.subplots(1,3,figsize=(12,4.7),layout='constrained')
for ax,s,color in zip(axs,['original','geometryTie','countGeometry'],colors):
    e=r['examples'][0]['selected'][s]
    ax.bar(range(1,9),e['sorted'],color=color,width=.7)
    ax.axhline(10,color='#273344',linestyle='--',linewidth=1)
    for i,v in enumerate(e['sorted'],1):ax.text(i,v+.08,str(v),ha='center')
    ax.set_ylim(0,12);ax.set_xticks(range(1,9));ax.set_xlabel('按潜在据点数排序的位置，不是席位编号')
    ax.set_title(f"{names[s]} · 种子 {e['seed']}\n领地差 {e['score']}，少于均值人数 {e['belowMean']}，方差 {e['variance']:.2f}",fontsize=10)
axs[0].set_ylabel('潜在据点数，包含初始 5 个据点')
fig.suptitle('同一个八人窗口：领地差相同，完整数量分布仍可不同',fontsize=14)
fig.savefig(out/'eight-player-quantities.png',dpi=160,bbox_inches='tight');fig.savefig(out/'eight-player-quantities.svg',bbox_inches='tight');plt.close(fig)
print('Saved quantity comparison and eight-player distributions')
