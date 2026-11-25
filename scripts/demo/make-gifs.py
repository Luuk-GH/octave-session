"""Makes the README highlight GIFs (media/gifs/*.gif) from the scenes recorded by run-demo.mjs with
DEMO_SCRIPT=highlights.js DEMO_SCREEN=1 DEMO_W=1440 DEMO_H=900.

Usage: python make-gifs.py <rec dir> <out dir>    (needs: pip install imageio-ffmpeg)
"""
import os
import subprocess
import sys
import tempfile

import imageio_ffmpeg

REC, OUT = sys.argv[1], sys.argv[2]
FPS = 12
HOLD = 1.5   # seconds the last frame stays before the GIF loops

# scene: (crop box x0, y0, x1, y1 in the 1440x900 window without its title bar, output width)
SCENES = {
    'run':           ((8, 44, 1428, 892), 1100),
    'commandwindow': ((538, 44, 1428, 892), 890),
    'input':         ((538, 448, 1428, 892), 890),
    'debug':         ((8, 44, 1428, 892), 1100),
    'workspace':     ((8, 44, 1428, 892), 1100),
}


def main() -> None:
    ff = imageio_ffmpeg.get_ffmpeg_exe()
    os.makedirs(OUT, exist_ok=True)
    for scene, ((x0, y0, x1, y1), width) in SCENES.items():
        d = os.path.join(REC, 'frames', scene)
        frames = sorted(f for f in os.listdir(d) if f.endswith('.jpg'))
        times = [int(t) for t in open(os.path.join(d, 'times.txt')).read().split()]
        n = min(len(frames), len(times)) - 1          # the last frame may be taken after the scene ended
        with tempfile.NamedTemporaryFile('w', suffix='.txt', delete=False) as lst:
            for i in range(n):
                dur = (times[i + 1] - times[i]) / 1000 if i + 1 < n else HOLD
                lst.write(f"file '{os.path.join(d, frames[i]).replace(os.sep, '/')}'\nduration {dur:.3f}\n")
            lst.write(f"file '{os.path.join(d, frames[n - 1]).replace(os.sep, '/')}'\n")
        out = os.path.join(OUT, f'{scene}.gif')
        vf = (f'crop={x1 - x0}:{y1 - y0}:{x0}:{y0},fps={FPS},scale={width}:-1:flags=lanczos,'
              'split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];'
              '[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle')
        subprocess.run([ff, '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', lst.name,
                        '-vf', vf, '-loop', '0', out], check=True)
        os.unlink(lst.name)
        print(f'{out}: {os.path.getsize(out) // 1024} KB, {n} frames')


if __name__ == '__main__':
    main()
