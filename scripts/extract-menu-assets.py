"""Cut the menu UI pieces out of the generated art sheets in public/assets/images/.

The sheets are flat JPGs with several items (and labels) on a dark background. Each piece is
cropped, its sheet background turned to alpha (GIMP-style colour-to-alpha, so glows stay soft),
trimmed, and saved as a PNG in public/assets/ui/ (icons in public/icons/).

Run from the project root:  python scripts/extract-menu-assets.py
Crop boxes are in sheet pixels (left, top, right, bottom); re-check them if a sheet is regenerated.
"""

from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'public/assets/images'
UI = ROOT / 'public/assets/ui'
ICONS = ROOT / 'public/icons'


def sheet(name: str) -> Image.Image:
    return Image.open(SRC / name).convert('RGB')


def bg_colour(img: Image.Image) -> np.ndarray:
    """Median of the four corner patches: the sheet's flat background."""
    a = np.asarray(img, dtype=np.float32)
    p = 12
    corners = np.concatenate([a[:p, :p], a[:p, -p:], a[-p:, :p], a[-p:, -p:]]).reshape(-1, 3)
    return np.median(corners, axis=0)


def colour_to_alpha(img: Image.Image, bg: np.ndarray, floor: float = 0.14, tol: float = 0) -> Image.Image:
    """Remove `bg` from `img`. Alpha below `floor` (JPEG noise) is dropped, and so is anything within
    `tol` (RGB distance) of the background, such as a sheet's faint grid lines."""
    a = np.asarray(img, dtype=np.float32)
    b = bg.reshape(1, 1, 3)
    up = np.where(a > b, (a - b) / np.maximum(255 - b, 1), 0)
    down = np.where(a < b, (b - a) / np.maximum(b, 1), 0)
    alpha = np.clip(np.max(np.maximum(up, down), axis=2), 0, 1)
    alpha = np.clip((alpha - floor) / (1 - floor), 0, 1)
    if tol:
        dist = np.linalg.norm(a - b, axis=2)
        alpha *= np.clip((dist - tol) / 24, 0, 1)
    safe = np.maximum(alpha, 1e-4)[..., None]
    rgb = np.clip((a - b) / safe + b, 0, 255)
    out = np.dstack([rgb, alpha * 255]).astype(np.uint8)
    return Image.fromarray(out, 'RGBA')


def trim(img: Image.Image, pad: int = 2) -> Image.Image:
    box = img.getchannel('A').point(lambda v: 255 if v > 40 else 0).getbbox()
    if not box:
        return img
    l, t, r, b = box
    return img.crop((max(l - pad, 0), max(t - pad, 0), min(r + pad, img.width), min(b + pad, img.height)))


def cut(src: Image.Image, box, name: str, *, floor: float = 0.14, tol: float = 0, size: int | None = None, out: Path = UI) -> None:
    piece = trim(colour_to_alpha(src.crop(box), bg_colour(src), floor, tol))
    if size:
        piece.thumbnail((size, size), Image.LANCZOS)
    piece.save(out / f'{name}.png', optimize=True)
    print(f'{name}.png {piece.size}')


def round_mask(size: tuple[int, int], radius: int, scale: int = 4) -> Image.Image:
    """Anti-aliased rounded-rect (or circle, radius = half size) mask."""
    w, h = size
    m = Image.new('L', (w * scale, h * scale), 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, w * scale - 1, h * scale - 1), radius * scale, fill=255)
    return m.resize(size, Image.LANCZOS)


def main() -> None:
    UI.mkdir(parents=True, exist_ok=True)
    ICONS.mkdir(parents=True, exist_ok=True)

    # Logo: the main wordmark only (no mascot, no "(VERSION 1)" note).
    cut(sheet('pickle_smash_logo.jpg'), (55, 40, 912, 392), 'logo', tol=40)

    # Buttons with baked-in text.
    btn = sheet('main_menu_buttons.jpg')
    cut(btn, (95, 130, 560, 335), 'btn-play')
    cut(btn, (645, 130, 1105, 335), 'btn-play-pressed')
    cut(btn, (95, 445, 560, 585), 'btn-howto')
    cut(btn, (645, 445, 1105, 585), 'btn-settings')
    cut(btn, (95, 680, 560, 815), 'btn-got-it')
    cut(btn, (645, 680, 1105, 815), 'btn-done')

    # Icons (labels below each are left out of the boxes).
    ic = sheet('game_icons_spritesheet.jpg')
    icons = {
        'icon-play': (38, 62, 160, 172),
        'icon-help': (176, 62, 298, 172),
        'icon-settings': (316, 58, 432, 172),
        'icon-sound-on': (448, 62, 578, 172),
        'icon-sound-off': (596, 62, 706, 172),
        'icon-fx-on': (728, 58, 850, 176),
        'icon-fx-off': (866, 58, 986, 176),
        'icon-easy': (40, 292, 182, 424),
        'icon-medium': (236, 292, 376, 424),
        'icon-hard': (428, 252, 568, 418),
        'icon-wins': (36, 520, 192, 652),
        'icon-winrate': (240, 520, 384, 652),
        'icon-rally': (456, 518, 558, 652),
        'icon-streak': (636, 510, 762, 652),
    }
    for name, box in icons.items():
        cut(ic, box, name, size=96)

    # In-match HUD and overlay buttons. These cells sit on a grid, so near-background colours are dropped.
    hud = sheet('hud_gameplay_buttons.jpg')
    cut(hud, (78, 350, 254, 530), 'hud-pause', tol=34, size=128)
    cut(hud, (350, 350, 526, 530), 'hud-pause-pressed', tol=34, size=128)
    cut(hud, (698, 348, 1100, 456), 'btn-resume', tol=34)
    cut(hud, (698, 488, 1100, 600), 'btn-play-again', tol=34)
    cut(hud, (56, 720, 320, 810), 'btn-restart', tol=34)
    cut(hud, (354, 720, 618, 810), 'btn-main-menu', tol=34)
    cut(hud, (948, 80, 1138, 252), 'hud-game-point', tol=34, size=160)
    # VS badge sits on the scoreboard bar: mask its circle rather than keying.
    vs = hud.crop((384, 104, 480, 200)).convert('RGBA')
    vs.putalpha(round_mask(vs.size, 48))
    vs.resize((64, 64), Image.LANCZOS).save(UI / 'hud-vs.png', optimize=True)
    print('hud-vs.png (64, 64)')

    # Volume slider knob: round, sitting on the slider track, so mask a circle instead of keying.
    dlg = sheet('dialog_controls_ui.jpg')
    knob = dlg.crop((598, 212, 674, 288)).resize((64, 64), Image.LANCZOS).convert('RGBA')
    knob.putalpha(round_mask(knob.size, 32))
    knob.save(UI / 'slider-knob.png', optimize=True)
    print('slider-knob.png', knob.size)

    # Carbon-fibre texture from inside the setup-card panel (opaque, used as a cover background).
    card = sheet('match_setup_card_ui.jpg').crop((90, 250, 490, 780))
    card.save(UI / 'card-texture.jpg', quality=85, optimize=True)
    print('card-texture.jpg', card.size)

    # How-to-play infographic, split into its touch and keyboard halves.
    howto = sheet('howto_controls_guide.jpg')
    howto.crop((52, 66, 664, 718)).save(UI / 'howto-touch.jpg', quality=85, optimize=True)
    howto.crop((712, 66, 1326, 718)).save(UI / 'howto-keyboard.jpg', quality=85, optimize=True)
    print('howto-touch.jpg / howto-keyboard.jpg')

    # Loading-screen backdrop (clean court; the splash art has its own logo and bar baked in).
    court = sheet('court_menu_background.jpg')
    court.save(UI / 'court-bg.jpg', quality=82, optimize=True)
    print('court-bg.jpg', court.size)

    # App icon: the master squircle, re-masked so the corners are truly transparent.
    master = sheet('app_store_icons.jpg').crop((76, 198, 684, 806)).convert('RGBA')
    master.putalpha(round_mask(master.size, 120))
    for px in (512, 192, 180, 48, 32):
        name = 'apple-touch-icon.png' if px == 180 else f'icon-{px}.png'
        im = master.resize((px, px), Image.LANCZOS)
        if px == 180:  # iOS adds its own mask and wants no transparency.
            flat = Image.new('RGB', im.size, (15, 27, 45))
            flat.paste(im, mask=im.getchannel('A'))
            im = flat
        im.save(ICONS / name, optimize=True)
    print('icons/ 512 192 180 48 32')


if __name__ == '__main__':
    main()
