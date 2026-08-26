# build/icon.ico 생성 — 앱의 🐑 마크와 같은 톤(어두운 배경 + 틸 테두리)의
# 간단한 경로 아이콘. 바탕화면/시작 메뉴/작업표시줄에서 쓰인다.
import os, math
from PIL import Image, ImageDraw

base = os.path.dirname(os.path.abspath(__file__))
out_dir = os.path.join(base, 'build')
os.makedirs(out_dir, exist_ok=True)

BG = (10, 14, 22, 255)
TEAL = (79, 216, 199, 255)
AMBER = (245, 166, 35, 255)
GREEN = (95, 216, 138, 255)
RED = (255, 107, 107, 255)

SS = 8  # 슈퍼샘플링 배율


def make(size):
    s = size * SS
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    pad = s * 0.045
    r = s * 0.20
    d.rounded_rectangle([pad, pad, s - 1 - pad, s - 1 - pad], radius=r, fill=BG,
                        outline=TEAL, width=max(1, int(s * 0.028)))

    # 지도 위 주행 경로처럼 보이는 곡선
    pts = []
    for i in range(101):
        t = i / 100
        x = s * (0.20 + 0.60 * t)
        y = s * (0.68 - 0.30 * t + 0.16 * math.sin(t * math.pi * 2.1))
        pts.append((x, y))
    d.line(pts, fill=TEAL, width=max(1, int(s * 0.075)), joint='curve')

    # 시작(초록) / 현재 위치(앰버) / 끝(빨강) 점
    def dot(p, color, rad):
        d.ellipse([p[0] - rad, p[1] - rad, p[0] + rad, p[1] + rad], fill=color)

    dot(pts[0], GREEN, s * 0.062)
    dot(pts[55], AMBER, s * 0.085)
    dot(pts[-1], RED, s * 0.062)

    return img.resize((size, size), Image.LANCZOS)


sizes = [16, 24, 32, 48, 64, 128, 256]
imgs = [make(n) for n in sizes]
ico_path = os.path.join(out_dir, 'icon.ico')
imgs[-1].save(ico_path, format='ICO', sizes=[(n, n) for n in sizes])
imgs[-1].save(os.path.join(out_dir, 'icon.png'), format='PNG')
print('wrote', ico_path, os.path.getsize(ico_path), 'bytes')
