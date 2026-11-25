"""Draws the extension icon (media/icon.png): an orange surface plot with two peaks on a deep-blue rounded
square, and a vinyl record ("session") in the lower right corner.

Usage: python scripts/icon/make-icon.py    (needs: pip install matplotlib numpy pillow)
"""
import io
import os

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
from matplotlib.colors import LightSource, LinearSegmentedColormap  # noqa: E402
from PIL import Image, ImageDraw, ImageFilter  # noqa: E402

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
N = 1024                      # drawing size; the icon is downscaled from this
OUT = os.path.join(ROOT, 'media', 'icon.png')
SIZE = 256


def background() -> Image.Image:
    """Rounded square with a vertical blue gradient and a soft top highlight."""
    grad = Image.new('RGB', (N, N))
    top, bottom = np.array([31, 90, 142]), np.array([10, 33, 62])
    for y in range(N):
        c = tuple(int(v) for v in top + (bottom - top) * (y / (N - 1)))
        ImageDraw.Draw(grad).line([(0, y), (N, y)], fill=c)
    mask = Image.new('L', (N, N), 0)
    ImageDraw.Draw(mask).rounded_rectangle((20, 20, N - 20, N - 20), radius=190, fill=255)
    img = Image.new('RGBA', (N, N), (0, 0, 0, 0))
    img.paste(grad, (0, 0), mask)
    glow = Image.new('L', (N, N), 0)
    ImageDraw.Draw(glow).ellipse((-200, -520, N + 200, 380), fill=38)
    glow = Image.composite(glow, Image.new('L', (N, N), 0), mask).filter(ImageFilter.GaussianBlur(40))
    img = Image.alpha_composite(img, Image.merge('RGBA', (glow, glow, glow, glow)))
    return img


def surface() -> Image.Image:
    """Two Gaussian peaks as a lit, gridded orange surface (transparent background)."""
    x, y = np.meshgrid(np.linspace(-2.6, 2.6, 30), np.linspace(-2.6, 2.6, 30))
    z = 1.0 * np.exp(-((x + 0.75) ** 2 + (y - 0.35) ** 2) / 0.42) \
        + 0.55 * np.exp(-((x - 0.85) ** 2 + (y + 0.45) ** 2) / 0.36)
    cmap = LinearSegmentedColormap.from_list('octave', ['#a8300d', '#e2561a', '#f6912a', '#ffd772'])
    rgb = LightSource(azdeg=300, altdeg=40).shade(z, cmap=cmap, vert_exag=1.2, blend_mode='soft')
    fig = plt.figure(figsize=(8, 8), dpi=160)
    ax = fig.add_subplot(projection='3d')
    ax.plot_surface(x, y, z, facecolors=rgb, rstride=1, cstride=1, linewidth=0.5, edgecolor='#7a2a0c',
                    antialiased=True, shade=False)
    ax.view_init(elev=24, azim=-58)
    ax.set_box_aspect((1, 1, 0.62))
    ax.set_axis_off()
    fig.patch.set_alpha(0)
    ax.patch.set_alpha(0)
    buf = io.BytesIO()
    fig.savefig(buf, format='png', transparent=True, bbox_inches='tight', pad_inches=0)
    plt.close(fig)
    im = Image.open(io.BytesIO(buf.getvalue())).convert('RGBA')
    return im.crop(im.getbbox())


def vinyl(r: int) -> Image.Image:
    """A vinyl record of radius r: grooves, a sheen and an orange label (with a soft drop shadow)."""
    s = 2 * r + 80
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    c = s // 2
    shadow = Image.new('L', (s, s), 0)
    ImageDraw.Draw(shadow).ellipse((c - r - 6, c - r + 4, c + r + 6, c + r + 16), fill=150)
    img.putalpha(shadow.filter(ImageFilter.GaussianBlur(14)))
    d = ImageDraw.Draw(img)
    d.ellipse((c - r - 14, c - r - 14, c + r + 14, c + r + 14), fill=(16, 36, 62, 255))   # rim on the background
    d.ellipse((c - r, c - r, c + r, c + r), fill=(24, 24, 28, 255))
    for g in range(int(r * 0.42), int(r * 0.95), 9):                                      # grooves
        d.ellipse((c - g, c - g, c + g, c + g), outline=(52, 54, 62, 255), width=2)
    sheen = Image.new('L', (s, s), 0)
    sd = ImageDraw.Draw(sheen)
    for start, end in ((200, 250), (20, 70)):
        sd.pieslice((c - r + 8, c - r + 8, c + r - 8, c + r - 8), start, end, fill=70)
    sd.ellipse((c - int(r * 0.4), c - int(r * 0.4), c + int(r * 0.4), c + int(r * 0.4)), fill=0)
    sheen = sheen.filter(ImageFilter.GaussianBlur(10))
    img = Image.alpha_composite(img, Image.merge('RGBA', (sheen.point(lambda v: 255),) * 3 + (sheen,)))
    d = ImageDraw.Draw(img)
    lr = int(r * 0.36)                                                                     # label
    d.ellipse((c - lr, c - lr, c + lr, c + lr), fill=(242, 138, 30, 255))
    d.ellipse((c - lr, c - lr, c + lr, c + lr), outline=(196, 96, 14, 255), width=6)
    ir = int(lr * 0.62)
    d.ellipse((c - ir, c - ir, c + ir, c + ir), outline=(214, 112, 20, 255), width=3)
    hr = int(r * 0.075)                                                                    # spindle hole
    d.ellipse((c - hr, c - hr, c + hr, c + hr), fill=(14, 14, 18, 255))
    return img


def main() -> None:
    img = background()
    surf = surface()
    w = int(N * 0.86)
    surf = surf.resize((w, int(surf.height * w / surf.width)), Image.LANCZOS)
    img.alpha_composite(surf, ((N - w) // 2 - 10, 140))
    rec = vinyl(205)
    img.alpha_composite(rec, (N - rec.width - 6, N - rec.height - 6))
    # Keep everything inside the rounded square.
    mask = Image.new('L', (N, N), 0)
    ImageDraw.Draw(mask).rounded_rectangle((20, 20, N - 20, N - 20), radius=190, fill=255)
    img.putalpha(Image.composite(img.getchannel('A'), Image.new('L', (N, N), 0), mask))
    img.resize((SIZE, SIZE), Image.LANCZOS).save(OUT, optimize=True)
    img.resize((512, 512), Image.LANCZOS).save(os.path.join(ROOT, 'dist', 'icon-512.png'))
    print(OUT, os.path.getsize(OUT) // 1024, 'KB')


if __name__ == '__main__':
    main()
