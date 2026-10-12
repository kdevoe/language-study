# Renders the 影 app icon set into a directory: python3 scripts/make-icon.py <out>.
# Needs Pillow and Shippori Mincho as shippori-600.ttf in the working directory
# (from fonts.googleapis.com/css2?family=Shippori+Mincho:wght@600).
import sys
from PIL import Image, ImageDraw, ImageFont, ImageFilter
S = 1024
TOP, BOT = (84, 128, 95), (38, 74, 49)     # the existing icon's greens
CREAM = (243, 241, 220)
SHADOW = (24, 52, 33)

def render(weight=600, size=S, glyph_scale=0.56, shadow=True):
    W = 2048  # supersample
    img = Image.new('RGB', (W, W))
    px = img.load()
    # Vertical gradient with a soft light from the top-left.
    for y in range(W):
        t = y / (W - 1)
        row = tuple(round(TOP[i] + (BOT[i] - TOP[i]) * t) for i in range(3))
        for x in range(W):
            px[x, y] = row
    glow = Image.new('L', (W, W), 0)
    ImageDraw.Draw(glow).ellipse((-W * 0.35, -W * 0.45, W * 0.75, W * 0.55), fill=40)
    glow = glow.filter(ImageFilter.GaussianBlur(W * 0.12))
    img = Image.composite(Image.new('RGB', (W, W), (120, 160, 128)), img, glow)

    font = ImageFont.truetype(f'shippori-{weight}.ttf', int(W * glyph_scale))
    l, t, r, b = font.getbbox('影')
    gx = (W - (r - l)) / 2 - l
    gy = (W - (b - t)) / 2 - t + W * 0.005
    if shadow:
        # 影 is "shadow": the glyph casts a faint, soft one down and to the right.
        sh = Image.new('L', (W, W), 0)
        ImageDraw.Draw(sh).text((gx + W * 0.022, gy + W * 0.03), '影', font=font, fill=110)
        sh = sh.filter(ImageFilter.GaussianBlur(W * 0.018))
        img = Image.composite(Image.new('RGB', (W, W), SHADOW), img, sh)
    ImageDraw.Draw(img).text((gx, gy), '影', font=font, fill=CREAM)
    return img.resize((size, size), Image.LANCZOS)

if __name__ == '__main__':
    out = sys.argv[1]
    base = render()
    base.save(f'{out}/logo.png', optimize=True)
    base.resize((180, 180), Image.LANCZOS).save(f'{out}/apple-touch-icon.png', optimize=True)
    base.resize((512, 512), Image.LANCZOS).save(f'{out}/icon-512.png', optimize=True)
    base.resize((192, 192), Image.LANCZOS).save(f'{out}/icon-192.png', optimize=True)
    base.resize((64, 64), Image.LANCZOS).save(f'{out}/favicon.png', optimize=True)
