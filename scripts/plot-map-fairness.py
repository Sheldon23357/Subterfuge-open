"""Static research figures. Requires matplotlib; reads saved data only."""
import json
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib import font_manager

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'artifacts/map-fairness-study'
data = json.loads((OUT / 'results.json').read_text(encoding='utf-8'))
font = Path('C:/Windows/Fonts/msyh.ttc')
if font.exists():
    font_manager.fontManager.addfont(str(font))
    plt.rcParams['font.family'] = font_manager.FontProperties(fname=str(font)).get_name()
plt.rcParams.update({'axes.unicode_minus': False, 'font.size': 10, 'axes.spines.top': False, 'axes.spines.right': False})
colors = {'original': '#6b7280', 'territoryTie': '#127f80', 'minimax': '#c77525'}
names = {'original': '原版筛选', 'territoryTie': '同领地评分择优', 'minimax': '所有合格图综合择优'}
fig, axs = plt.subplots(1, 3, figsize=(14, 4.6), layout='constrained')
for ax, (key, title) in zip(axs, [('objective', '三项相对差异的最大值 ↓'), ('minBorder', '最近敌我边境距离 ↑'), ('score', '潜在领地数量差 ↓')]):
    for strategy in names:
        xs = list(range(2, 11))
        ys = [data['groups'][f'{n}/validation'][strategy][key]['mean'] for n in xs]
        ax.plot(xs, ys, 'o-', label=names[strategy], color=colors[strategy], linewidth=2)
    ax.set_title(title)
    ax.set_xlabel('玩家人数')
    ax.set_xticks(range(2,11))
    ax.grid(axis='y', alpha=.2)
axs[0].legend(fontsize=8, loc='upper left')
fig.suptitle('初始地图筛选比较   每种人数 10 组验证窗口，每组 500 个候选', fontsize=14)
fig.savefig(OUT / 'strategy-comparison.png', dpi=170, bbox_inches='tight')
fig.savefig(OUT / 'strategy-comparison.svg', bbox_inches='tight')
plt.close(fig)

fig, axs = plt.subplots(1, 2, figsize=(12, 6.5), layout='constrained')
palette = ['#1479b8','#d96325','#3d9240','#a344a2','#b39300','#a24849','#178c8c','#665bc5']
for ax, example in zip(axs, data['examples'][:2]):
    m = example['map']
    for i, o in enumerate(m['outposts']):
        p=o['position']; owner=o['owner']
        ax.scatter(p['x'],p['y'],c=palette[owner] if owner>=0 else '#d1d5db',s=48 if owner>=0 else 25,edgecolors='white',linewidths=.5,zorder=3)
    for q in m['queens']:
        p=m['outposts'][q['outpost']]['position']
        ax.scatter(p['x'],p['y'],marker='*',s=260,c=palette[q['owner']],edgecolors='#17212b',linewidths=.8,zorder=4,clip_on=False)
        ax.annotate(str(q['owner']+1),(p['x'],p['y']),xytext=(-12 if p['x']>m['width']/2-2 else 5,5),textcoords='offset points',fontsize=9)
    for p in m['origins']:
        ax.scatter(p['x'],p['y'],marker='+',s=55,c='#222222',linewidths=1,zorder=2)
    metric=example['metrics']
    ax.set_title(f"{names[example['strategy']]}   种子 {example['seed']}\n领地差 {metric['score']}   综合差异 {metric['objective']:.3f}   最近边境 {metric['minBorder']:.2f}",fontsize=11)
    ax.set_xlim(-m['width']/2,m['width']/2);ax.set_ylim(-m['height']/2,m['height']/2)
    ax.set_aspect('equal');ax.grid(alpha=.15);ax.set_xlabel('X 坐标 · 左右边界相连');ax.set_ylabel('Y 坐标 · 上下边界相连')
fig.suptitle('同一个 8 人候选窗口：4300 至 4799\n彩色点为初始领地，灰点为中立，星号为女王，十字为虚拟中心',fontsize=13)
fig.savefig(OUT / 'eight-player-maps.png',dpi=170,bbox_inches='tight')
fig.savefig(OUT / 'eight-player-maps.svg',bbox_inches='tight')
plt.close(fig)
print('Saved strategy-comparison and eight-player-maps as PNG and SVG')
