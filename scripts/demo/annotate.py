"""Makes media/overview.png (the README image) from the "overview" frame recorded by run-demo.mjs.

Usage: python annotate.py <rec dir> <out.png>    (needs: pip install pillow)
"""
import glob
import os
import sys

from PIL import Image, ImageDraw, ImageFont

REC, OUT = sys.argv[1], sys.argv[2]
TITLEBAR = 43
ORANGE = (247, 147, 30)
F = 'C:/Windows/Fonts/'
f_lab = ImageFont.truetype(F + 'seguisb.ttf', 30)
f_num = ImageFont.truetype(F + 'seguibl.ttf', 30)

frames = sorted(glob.glob(os.path.join(REC, 'frames', 'overview', '*.jpg')))
im = Image.open(frames[-2]).convert('RGB')          # the last frame may be taken after the scene ended
d = ImageDraw.Draw(im)

# (number, box in window pixels, label, label anchor corner)
NOTES = [
    (1, (84, 52, 503, 348), 'Workspace view', 'below'),
    (2, (522, 88, 1902, 505), 'Editor: F5 runs the file, Ctrl+Enter the %% section, F9 the line', 'br'),
    (3, (522, 658, 1902, 1014), 'Command Window: the same live Octave session', 'br'),
    (4, (72, 1036, 168, 1068), 'Session status', 'above'),
]


def label(x, y, num, text):
    """Draws a numbered pill with its top-left corner at (x, y); returns its size."""
    nw = 44
    tw = d.textlength(text, font=f_lab)
    w, h = nw + tw + 30, 50
    d.rounded_rectangle((x, y, x + w, y + h), radius=12, fill=ORANGE)
    d.ellipse((x + 6, y + 5, x + 6 + 40, y + 45), fill=(30, 30, 30))
    n = str(num)
    d.text((x + 26 - d.textlength(n, font=f_num) / 2, y + 4), n, font=f_num, fill=ORANGE)
    d.text((x + nw + 14, y + 6), text, font=f_lab, fill=(25, 25, 25))
    return w, h


for num, (x0, y0, x1, y1), text, where in NOTES:
    d.rounded_rectangle((x0, y0, x1, y1), radius=10, outline=ORANGE, width=4)
    w = 44 + d.textlength(text, font=f_lab) + 30
    if where == 'bl':
        label(x0 + 14, y1 - 64, num, text)
    elif where == 'br':
        label(x1 - w - 14, y1 - 64, num, text)
    elif where == 'below':
        label(x0, y1 + 14, num, text)
    else:
        label(x0 + 10, y0 - 64, num, text)

im = im.crop((0, TITLEBAR, im.width, im.height))
im = im.resize((1600, round(im.height * 1600 / im.width)), Image.LANCZOS)
im = im.quantize(256, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE)   # small enough to embed in the .vsix README
im.save(OUT, optimize=True)
print(OUT, im.size, os.path.getsize(OUT) // 1024, 'KB')
