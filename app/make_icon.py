"""Draws the NEXUS app icon (same mark as the studio logo) -> app/nexus.ico."""
import os

from PIL import Image, ImageDraw, ImageFilter

S = 512
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
# rounded tile with a violet-to-ink gradient
grad = Image.new("RGBA", (S, S))
gd = ImageDraw.Draw(grad)
for y in range(S):
    t = y / S
    gd.line([(0, y), (S, y)], fill=(int(40 - 18 * t), int(30 - 14 * t), int(72 - 44 * t), 255))
mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([16, 16, S - 16, S - 16], radius=112, fill=255)
img.paste(grad, (0, 0), mask)
d = ImageDraw.Draw(img)
d.rounded_rectangle([16, 16, S - 16, S - 16], radius=112, outline=(139, 124, 246, 170), width=10)
# glow + "N" path (M9 23 V9 l14 14 V9 on a 32 grid)
k = S / 32
pts = [(9 * k, 23 * k), (9 * k, 9 * k), (23 * k, 23 * k), (23 * k, 9 * k)]
glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
ImageDraw.Draw(glow).line(pts, fill=(139, 124, 246, 160), width=int(3.2 * k), joint="curve")
img.alpha_composite(glow.filter(ImageFilter.GaussianBlur(18)))
d.line(pts, fill=(164, 150, 255, 255), width=int(2.6 * k), joint="curve")
for x, y in (pts[0], pts[-1]):
    r = 1.3 * k
    d.ellipse([x - r, y - r, x + r, y + r], fill=(164, 150, 255, 255))
r = 2.3 * k
d.ellipse([23 * k - r, 9 * k - r, 23 * k + r, 9 * k + r], fill=(94, 200, 216, 255))

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "nexus.ico")
img.save(out, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
img.save(out.replace(".ico", ".png"))
print(out)
