"""Builds the demo video from the frames recorded by run-demo.mjs.

Usage: python compose.py <rec dir> <out.mp4>    (needs: pip install pillow imageio-ffmpeg)
"""
import glob
import os
import subprocess
import sys

import imageio_ffmpeg
from PIL import Image, ImageDraw, ImageFont

REC, OUT = sys.argv[1], sys.argv[2]
HERE = os.path.dirname(os.path.abspath(__file__))
LOGO = os.path.join(HERE, '..', '..', 'media', 'octave-logo.png')
W, H, FPS = 1920, 1080, 25
BAND = 110                      # caption band under the VS Code window
TITLEBAR = 43                   # VS Code title bar rows cropped from each frame
BG = (24, 24, 24)
FG = (232, 232, 232)
DIM = (150, 150, 150)
ACCENT = (247, 147, 30)          # Octave orange
CODEBG = (40, 40, 40)
FADE = 0.35

F = 'C:/Windows/Fonts/'
def font(name, size): return ImageFont.truetype(F + name, size)
f_title = font('seguibl.ttf', 84)
f_sub = font('segoeui.ttf', 40)
f_cap = font('seguisb.ttf', 40)
f_capdim = font('segoeui.ttf', 30)
f_h = font('seguisb.ttf', 56)
f_body = font('segoeui.ttf', 34)
f_bodyb = font('seguisb.ttf', 34)
f_code = font('consola.ttf', 32)
f_step = font('seguisb.ttf', 26)

logo = Image.open(LOGO).convert('RGBA')


def scene_frames(name, drop_last=1):
    """[(image, seconds)] for a recorded scene, each frame held until the next one was taken."""
    d = os.path.join(REC, 'frames', name)
    files = sorted(glob.glob(os.path.join(d, '*.jpg')))
    times = [int(t) / 1000 for t in open(os.path.join(d, 'times.txt')).read().split()]
    n = min(len(files), len(times)) - drop_last
    out = []
    for i in range(n):
        dur = (times[i + 1] - times[i]) if i + 1 < len(times) else 0.4
        out.append((files[i], dur))
    return out


def centered(draw, y, text, fnt, fill):
    w = draw.textlength(text, font=fnt)
    draw.text(((W - w) / 2, y), text, font=fnt, fill=fill)


def frame_canvas(shot_path, caption, sub, step):
    im = Image.open(shot_path).convert('RGB')
    im = im.crop((0, TITLEBAR, im.width, im.height))
    scale = (H - BAND) / im.height
    im = im.resize((round(im.width * scale), H - BAND), Image.LANCZOS)
    c = Image.new('RGB', (W, H), BG)
    c.paste(im, ((W - im.width) // 2, 0))
    d = ImageDraw.Draw(c)
    d.rectangle((0, H - BAND, W, H), fill=(18, 18, 18))
    d.rectangle((0, H - BAND, W, H - BAND + 3), fill=ACCENT)
    x = 60
    if step:
        tag = f' {step} '
        tw = d.textlength(tag, font=f_step)
        d.rounded_rectangle((x, H - BAND + 30, x + tw + 10, H - BAND + 76), radius=10, fill=ACCENT)
        d.text((x + 5, H - BAND + 36), tag, font=f_step, fill=(20, 20, 20))
        x += tw + 34
    if sub:
        d.text((x, H - BAND + 12), caption, font=f_cap, fill=FG)
        d.text((x, H - BAND + 62), sub, font=f_capdim, fill=DIM)
    else:
        d.text((x, H - BAND + 30), caption, font=f_cap, fill=FG)
    return c


def code_line(d, x, y, text, width=None):
    w = width or d.textlength(text, font=f_code) + 40
    d.rounded_rectangle((x, y, x + w, y + 54), radius=8, fill=CODEBG)
    d.text((x + 20, y + 9), text, font=f_code, fill=(206, 145, 120))


def title_card():
    c = Image.new('RGB', (W, H), BG)
    lg = logo.resize((300, 300), Image.LANCZOS)
    c.paste(lg, ((W - 300) // 2, 170), lg)
    d = ImageDraw.Draw(c)
    centered(d, 510, 'GNU Octave in VS Code', f_title, FG)
    centered(d, 625, 'A MATLAB-style workflow: run, debug, inspect variables, and let AI agents help',
             f_sub, DIM)
    centered(d, 720, 'octave-session 0.1.3  ·  Windows  ·  uses your own GNU Octave install', f_capdim, ACCENT)
    return c


def skills_card():
    c = Image.new('RGB', (W, H), BG)
    d = ImageDraw.Draw(c)
    lg = logo.resize((90, 90), Image.LANCZOS)
    c.paste(lg, (140, 95), lg)
    d.text((255, 100), 'Agent skills: the octave-core plugin', font=f_h, fill=FG)
    d.text((255, 172), 'They teach Claude Code (or Copilot) to work in your live session through the MCP server',
           font=f_capdim, fill=DIM)
    rows = [
        ('octave-run-code', 'run code in the shared session; no separate octave-cli; leave your workspace as it was'),
        ('octave-debugging', 'reproduce, read the error, set breakpoints, step, inspect, fix, verify'),
        ('octave-testing', 'write %!assert / %!test blocks and run them with test()'),
        ('octave-review-code', 'syntax check, correctness (each finding confirmed by running it), MATLAB portability'),
    ]
    y = 285
    for name, desc in rows:
        d.ellipse((150, y + 14, 166, y + 30), fill=ACCENT)
        d.text((190, y), name, font=f_bodyb, fill=FG)
        d.text((520, y), desc, font=f_body, fill=(200, 200, 200))
        y += 78
    d.text((150, 640), 'Install in Claude Code:', font=f_bodyb, fill=FG)
    code_line(d, 150, 700, '/plugin marketplace add <repo>\\agent-toolkit', 1620)
    code_line(d, 150, 770, '/plugin install octave-core@octave-agentic-toolkit', 1620)
    d.text((150, 860), 'Copilot: copy the skill folders to .github/skills or ~/.copilot/skills',
           font=f_capdim, fill=DIM)
    return c


def end_card():
    c = Image.new('RGB', (W, H), BG)
    lg = logo.resize((200, 200), Image.LANCZOS)
    c.paste(lg, ((W - 200) // 2, 170), lg)
    d = ImageDraw.Draw(c)
    centered(d, 410, 'Get started', f_title, FG)
    t = 'code --install-extension octave-session-0.1.3.vsix'
    w = d.textlength(t, font=f_code) + 40
    code_line(d, (W - w) / 2, 540, t)
    centered(d, 640, 'Needs GNU Octave installed (auto-detected; tested with Octave 11.1 on Windows)', f_capdim, DIM)
    centered(d, 690, 'Then open a .m file and press F5', f_capdim, DIM)
    centered(d, 800, 'GNU Octave logo © the Octave project. Not affiliated with or endorsed by GNU Octave or MathWorks.',
             font('segoeui.ttf', 22), (110, 110, 110))
    return c


# (kind, content, caption, subcaption, step label, max seconds)
SEGMENTS = [
    ('card', title_card, None, None, None, 3.5),
    ('scene', 'install_palette', 'Install: Command Palette  ›  Extensions: Install from VSIX…',
     'or from a terminal:  code --install-extension octave-session-0.1.3.vsix', 'INSTALL', 3.6),
    ('scene', 'install_details', 'Installed: GNU Octave Session',
     'It finds your GNU Octave install automatically, no setup needed', 'INSTALL', 3.6),
    ('scene', 'runfile', 'Run a script with F5',
     'One persistent Octave session; output goes to the Octave Command Window', 'RUN', None),
    ('scene', 'section', 'Run the current %% section with Ctrl+Enter',
     'F9 runs the selection or the current line', 'RUN', None),
    ('scene', 'terminal', 'Command Window: a live Octave prompt',
     'Tab completes functions, variables and struct fields; help works as usual', 'COMMAND WINDOW', 9.5),
    ('scene', 'workspace', 'Workspace view',
     'Browse variables and their values (hover for size and class); expand structs and cells', 'WORKSPACE', 4.6),
    ('scene', 'debug', 'Debug with breakpoints',
     'Step through code, see variables and the call stack, use the Command Window while paused', 'DEBUG', None),
    ('scene', 'edit', 'edit and open open files in VS Code',
     '"edit name" opens a function, or creates name.m if it does not exist yet', 'EDITOR', None),
    ('scene', 'mcp_settings', 'Built-in MCP server for AI agents',
     'Turn it on with one setting; it only listens on 127.0.0.1 and needs an access token', 'AI AGENTS', 3.6),
    ('scene', 'mcp_setup', 'Octave: Set Up MCP Server',
     'Copies the connection command for Claude Code, or JSON for Copilot and Cursor', 'AI AGENTS', 3.6),
    ('card', skills_card, None, None, None, 6.5),
    ('card', end_card, None, None, None, 4.0),
]


def segment_frames(seg):
    """Yields the segment's frames as PIL images at FPS."""
    kind, content, cap, sub, step, maxs = seg
    if kind == 'card':
        img = content()
        for _ in range(round(maxs * FPS)):
            yield img
        return
    shots = scene_frames(content)
    total = sum(dur for _, dur in shots)
    limit = maxs or total
    t, cache = 0.0, {}
    i, acc = 0, shots[0][1]
    while t < limit:
        while acc <= t and i + 1 < len(shots):
            i += 1
            acc += shots[i][1]
        p = shots[i][0]
        if p not in cache:
            cache.clear()
            cache[p] = frame_canvas(p, cap, sub, step)
        yield cache[p]
        t += 1 / FPS


def main():
    ff = imageio_ffmpeg.get_ffmpeg_exe()
    proc = subprocess.Popen([ff, '-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}',
                             '-r', str(FPS), '-i', '-', '-c:v', 'libx264', '-preset', 'slow', '-crf', '20',
                             '-pix_fmt', 'yuv420p', '-movflags', '+faststart', OUT], stdin=subprocess.PIPE)
    nf = round(FADE * FPS)
    prev_tail = []
    count = 0
    for k, seg in enumerate(SEGMENTS):
        frames = list(segment_frames(seg))
        if prev_tail:                                   # crossfade the previous tail into this head
            for j in range(nf):
                a = (j + 1) / (nf + 1)
                proc.stdin.write(Image.blend(prev_tail[j], frames[j], a).tobytes())
                count += 1
            frames = frames[nf:]
        last = k == len(SEGMENTS) - 1
        body = frames if last else frames[:-nf]
        if k == 0:                                      # fade in from black
            black = Image.new('RGB', (W, H), (0, 0, 0))
            for j in range(nf):
                body[j] = Image.blend(black, body[j], (j + 1) / nf)
        if last:                                        # fade out to black
            black = Image.new('RGB', (W, H), (0, 0, 0))
            for j in range(nf):
                body[-nf + j] = Image.blend(body[-nf + j], black, (j + 1) / nf)
        for im in body:
            proc.stdin.write(im.tobytes())
            count += 1
        prev_tail = [] if last else frames[-nf:]
        print(f'{seg[1] if isinstance(seg[1], str) else seg[1].__name__}: {len(frames) / FPS:.1f}s', flush=True)
    proc.stdin.close()
    proc.wait()
    print(f'{count / FPS:.1f} s -> {OUT}')


if __name__ == '__main__':
    main()
