"""Render observer report charts from frozen JSON; Pillow only, no game writes."""
import json
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo
from PIL import Image, ImageDraw, ImageFont

source = Path(sys.argv[1]).resolve()
data = json.loads(source.read_text(encoding='utf-8'))
output = source.parent
FONT = 'C:/Windows/Fonts/msyh.ttc'
COLORS = ['#67dbc9', '#ed8f7f', '#d6a85d', '#77a9e5', '#c9cf76', '#b59ce7', '#c8dbe5', '#6ab783', '#d68bb7', '#d2b698']
BG, CARD, INK, MUTED, GRID = '#081b28', '#102b3a', '#edf4f6', '#a4b8c4', '#234352'

def font(size):
    return ImageFont.truetype(FONT, size)

def text(draw, xy, value, size=25, fill=INK):
    draw.text(xy, str(value), font=font(size), fill=fill)

def local_time(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00')).astimezone(ZoneInfo('Asia/Hong_Kong')).strftime('%m月%d日 %H:%M')

def canvas(width, height, title):
    im = Image.new('RGB', (width, height), BG)
    d = ImageDraw.Draw(im)
    text(d, (52, 30), title, 39)
    minutes = data['tick'] * 10
    subtitle = f"{local_time(data['capturedAt'])} HKT  ·  游戏 {minutes // 60}h{minutes % 60:02d}m  ·  tick {data['tick']}"
    text(d, (54, 91), subtitle, 24, MUTED)
    return im, d

card_bottom = 295 + 55 * len(data['players'])
im, d = canvas(1800, card_bottom + 115, '深潜 / 战局基线' if data['baseline'] else '深潜 / 两小时战报')
metrics = [('neptunium', '海王星矿 · 当前库存'), ('outposts', '领土 · 据点总数'), ('drillers', '兵力 · 据点与舰队合计')]
for panel, (key, title) in enumerate(metrics):
    x = 45 + panel * 575
    d.rounded_rectangle((x, 155, x + 555, card_bottom), radius=18, fill=CARD)
    text(d, (x + 25, 179), title, 27)
    ordered = sorted(data['players'], key=lambda p: (-p[key], p['seat']))
    maximum = max(1, max(p[key] for p in ordered)) * 1.18
    for row, player in enumerate(ordered):
        y = 247 + row * 55
        color = COLORS[player['seat']]
        text(d, (x + 24, y - 1), player['name'], 25, color)
        d.rounded_rectangle((x + 99, y + 5, x + 400, y + 29), radius=5, fill=GRID)
        length = max(1, 301 * player[key] / maximum)
        d.rounded_rectangle((x + 99, y + 5, x + 99 + length, y + 29), radius=5, fill=color)
        suffix = '' if player['delta'] is None else f" ({player['delta'][key]:+})"
        text(d, (x + 412, y - 1), f"{player[key]}{suffix}", 23)
    if key == 'neptunium' and data['goal']:
        leader = max(ordered, key=lambda p: p[key])
        text(d, (x + 25, card_bottom - 38), f"目标 {data['goal']} · 领先者完成 {leader[key] / data['goal']:.1%}", 20, MUTED)
foot = '首次采样，不虚构期内增减；下一期开始比较变化。' if data['baseline'] else f"对比上期：{local_time(data['previousAt'])} → {local_time(data['capturedAt'])}，+{data['tick'] - data['previousTick']} tick"
text(d, (53, card_bottom + 28), foot, 25, MUTED)
text(d, (53, card_bottom + 70), 'OB 全图采样 · 领土含矿场 · 兵力不等同可调兵力 · 排名图按各项指标分别排序', 21, MUTED)
im.save(output / 'overview.png')

im, d = canvas(1200, 1210, '深潜 / 据点控制图')
d.rounded_rectangle((40, 155, 1160, 1080), radius=18, fill=CARD)
w, h = data['map']['size']['width'], data['map']['size']['height']
scale = min(970 / w, 790 / h)
occupied = []
for post in data['map']['outposts']:
    pos = post['position']
    x, y = 600 + pos['x'] * scale, 615 - pos['y'] * scale
    occupied.append((x-12, y-12, x+12, y+12))
for post in data['map']['outposts']:
    pos = post['position']
    x, y = 600 + pos['x'] * scale, 615 - pos['y'] * scale
    color = COLORS[post['owner']] if post['owner'] is not None else '#536574'
    if post['type'] == 'mine':
        d.polygon([(x, y-12), (x+12, y), (x, y+12), (x-12, y)], fill=color)
    else:
        d.ellipse((x-8, y-8, x+8, y+8), fill=color)
    label_font = font(15)
    for dx, dy in [(13, -12), (13, 7), (13, -31), (-110, -12), (-110, 12), (5, 21), (-40, -34)]:
        bounds = d.textbbox((x+dx, y+dy), post['name'], font=label_font)
        if bounds[0] < 45 or bounds[2] > 1155 or bounds[1] < 160 or bounds[3] > 1075:
            continue
        if not any(bounds[0] < b[2]+3 and bounds[2] > b[0]-3 and bounds[1] < b[3]+3 and bounds[3] > b[1]-3 for b in occupied):
            break
    d.text((x+dx, y+dy), post['name'], font=label_font, fill=color)
    occupied.append(bounds)
for player in data['players']:
    x = 55 + player['seat'] % 6 * 187
    text(d, (x, 1110), f"● {player['name']}", 24, COLORS[player['seat']])
text(d, (53, 1162), '菱形为矿场，圆形为其他据点；环绕地图边缘相邻，本图不绘制直线航程。', 20, MUTED)
im.save(output / 'map.png')

history = data['history']
if len(history) > 1:
    im, d = canvas(1800, 930, '深潜 / 战局趋势')
    timestamps = [datetime.fromisoformat(r['capturedAt'].replace('Z', '+00:00')).timestamp() for r in history]
    span = max(1, timestamps[-1] - timestamps[0])
    for panel, (key, title) in enumerate(metrics):
        left, top, width, height = 75 + 575 * panel, 225, 480, 420
        text(d, (left, 162), title, 26)
        ymax = max(1, max(p[key] for item in history for p in item['players'])) * 1.15
        for step in range(5):
            y = top + height - height * step / 4
            d.line((left, y, left+width, y), fill=GRID, width=1)
            text(d, (left+3, y-27), f'{ymax*step/4:.0f}', 18, MUTED)
        for player in data['players']:
            points = [(left + width*(timestamps[i]-timestamps[0])/span, top+height-height*item['players'][player['seat']][key]/ymax) for i, item in enumerate(history)]
            d.line(points, fill=COLORS[player['seat']], width=4)
            for x, y in points:
                d.ellipse((x-4, y-4, x+4, y+4), fill=COLORS[player['seat']])
        text(d, (left, 667), local_time(history[0]['capturedAt']), 18, MUTED)
        text(d, (left+width-170, 699), local_time(history[-1]['capturedAt']), 18, MUTED)
    for player in data['players']:
        text(d, (75+(player['seat'] % 6)*275, 765+(player['seat']//6)*48), f"● {player['name']}", 25, COLORS[player['seat']])
    text(d, (75, 875), '横轴为现实采样时间；折线仅连接实测采样点，不代表期间逐刻变化。', 21, MUTED)
    im.save(output / 'trend.png')
print(json.dumps({'overview': str(output/'overview.png'), 'map': str(output/'map.png'), 'trend': str(output/'trend.png') if len(history)>1 else None}, ensure_ascii=False))
