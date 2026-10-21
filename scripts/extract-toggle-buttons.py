"""Extract the toggle and controls button assets for Pickle Smash.

Extracts transparent PNG buttons and icons from:
- public/assets/images/settings_audio_buttons.jpg
- public/assets/images/settings_effects_buttons.jpg
- public/assets/images/settings_controls_buttons.jpg
- public/assets/images/toggle_button_frame.jpg

Outputs clean PNGs into public/assets/ui/ and public/icons/.
"""

from pathlib import Path
from PIL import Image, ImageDraw
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'public/assets/images'
UI = ROOT / 'public/assets/ui'
ICONS = ROOT / 'public/icons'
ARTIFACTS = Path(r'C:\Users\Desktop\.gemini\antigravity-ide\brain\52a6c512-a66e-40cc-86d3-1410e2fcdc31')


def bg_colour(img: Image.Image) -> np.ndarray:
    a = np.asarray(img, dtype=np.float32)
    p = 12
    corners = np.concatenate([a[:p, :p], a[:p, -p:], a[-p:, :p], a[-p:, -p:]]).reshape(-1, 3)
    return np.median(corners, axis=0)


def round_pill_mask(size: tuple[int, int], radius: int, scale: int = 4) -> Image.Image:
    w, h = size
    m = Image.new('L', (w * scale, h * scale), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle((0, 0, w * scale - 1, h * scale - 1), radius * scale, fill=255)
    return m.resize(size, Image.LANCZOS)


def colour_to_alpha(img: Image.Image, bg: np.ndarray, floor: float = 0.15, tol: float = 30) -> Image.Image:
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
    return Image.fromarray(out)


def extract_pill_button(
    sheet_img: Image.Image,
    crop_box: tuple[int, int, int, int],
    name: str,
    out_dir: Path = UI,
    target_width: int | None = 520,
) -> Image.Image:
    bg = bg_colour(sheet_img)
    cropped = sheet_img.crop(crop_box)
    with_alpha = colour_to_alpha(cropped, bg, floor=0.15, tol=30)
    
    # Pill mask
    mask = round_pill_mask(with_alpha.size, radius=with_alpha.size[1] // 2)
    a_chan = np.asarray(with_alpha.getchannel('A'), dtype=np.float32)
    m_chan = np.asarray(mask, dtype=np.float32) / 255.0
    final_a = (a_chan * m_chan).astype(np.uint8)
    with_alpha.putalpha(Image.fromarray(final_a))
    
    if target_width:
        ratio = target_width / with_alpha.width
        target_height = int(round(with_alpha.height * ratio))
        with_alpha = with_alpha.resize((target_width, target_height), Image.LANCZOS)
    
    out_path = out_dir / f'{name}.png'
    with_alpha.save(out_path, optimize=True)
    print(f'Extracted {out_path.name}: {with_alpha.size}')
    return with_alpha


def extract_icon(
    sheet_img: Image.Image,
    crop_box: tuple[int, int, int, int],
    name: str,
    size: int = 96,
) -> Image.Image:
    bg = bg_colour(sheet_img)
    cropped = sheet_img.crop(crop_box)
    with_alpha = colour_to_alpha(cropped, bg, floor=0.18, tol=40)
    with_alpha.thumbnail((size, size), Image.LANCZOS)
    
    with_alpha.save(ICONS / f'{name}.png', optimize=True)
    with_alpha.save(UI / f'{name}.png', optimize=True)
    print(f'Extracted icon {name}.png: {with_alpha.size}')
    return with_alpha


def main():
    UI.mkdir(parents=True, exist_ok=True)
    ICONS.mkdir(parents=True, exist_ok=True)

    # 1. Audio Toggle Buttons (State 1: MUTE AUDIO, State 2: UNMUTE AUDIO)
    aud_sheet = Image.open(SRC / 'settings_audio_buttons.jpg').convert('RGB')
    btn_mute = extract_pill_button(aud_sheet, (181, 102, 1194, 318), 'btn-mute-audio')
    btn_unmute = extract_pill_button(aud_sheet, (181, 452, 1194, 668), 'btn-unmute-audio')

    # 2. Effects Toggle Buttons (State 1: EFFECTS: FULL, State 2: EFFECTS: REDUCED)
    fx_sheet = Image.open(SRC / 'settings_effects_buttons.jpg').convert('RGB')
    btn_fx_full = extract_pill_button(fx_sheet, (181, 102, 1194, 318), 'btn-fx-full')
    btn_fx_red = extract_pill_button(fx_sheet, (181, 452, 1194, 668), 'btn-fx-reduced')

    # 3. Controls Toggle Buttons (State 1: AIM & CHARGE, State 2: SWIPE)
    ctrl_sheet = Image.open(SRC / 'settings_controls_buttons.jpg').convert('RGB')
    btn_ctrl_charge = extract_pill_button(ctrl_sheet, (181, 102, 1194, 318), 'btn-controls-charge')
    # Save alias btn-controls-aim.png
    btn_ctrl_charge.save(UI / 'btn-controls-aim.png', optimize=True)
    btn_ctrl_swipe = extract_pill_button(ctrl_sheet, (181, 452, 1194, 668), 'btn-controls-swipe')

    # Isolated Control Icons
    icon_aim = extract_icon(ctrl_sheet, (225, 128, 390, 292), 'icon-controls-aim', size=96)
    icon_swipe = extract_icon(ctrl_sheet, (235, 478, 385, 642), 'icon-controls-swipe', size=96)

    # 4. Modular Toggle Button Frames (Normal, Active/Selected, Dimmed)
    frm_sheet = Image.open(SRC / 'toggle_button_frame.jpg').convert('RGB')
    btn_frm_normal = extract_pill_button(frm_sheet, (280, 75, 1095, 255), 'btn-toggle-frame')
    btn_frm_active = extract_pill_button(frm_sheet, (280, 295, 1095, 475), 'btn-toggle-frame-active')
    btn_frm_dim = extract_pill_button(frm_sheet, (280, 515, 1095, 695), 'btn-toggle-frame-dim')

    # 5. Build a comprehensive Showcase Preview Card on dark panel background
    card_w, card_h = 1140, 740
    showcase = Image.new('RGB', (card_w, card_h), (16, 34, 54))
    draw = ImageDraw.Draw(showcase)
    
    # Outer border matching game modal
    draw.rounded_rectangle((10, 10, card_w - 11, card_h - 11), 24, outline=(90, 220, 255), width=2)
    
    # Col 1: State A (Normal / Active)
    # Col 2: State B (Toggled / Off)
    col1_x = 40
    col2_x = 580
    row_y = [50, 180, 310, 440]

    # Row 1: Audio
    showcase.paste(btn_mute, (col1_x, row_y[0]), btn_mute)
    showcase.paste(btn_unmute, (col2_x, row_y[0]), btn_unmute)

    # Row 2: Effects
    showcase.paste(btn_fx_full, (col1_x, row_y[1]), btn_fx_full)
    showcase.paste(btn_fx_red, (col2_x, row_y[1]), btn_fx_red)

    # Row 3: Controls
    showcase.paste(btn_ctrl_charge, (col1_x, row_y[2]), btn_ctrl_charge)
    showcase.paste(btn_ctrl_swipe, (col2_x, row_y[2]), btn_ctrl_swipe)

    # Row 4: Modular Frames
    # Resize frame to half width for 2 slots
    half_frm_w = 500
    frm_norm_scaled = btn_frm_normal.resize((half_frm_w, int(btn_frm_normal.height * (half_frm_w / btn_frm_normal.width))), Image.LANCZOS)
    frm_act_scaled = btn_frm_active.resize((half_frm_w, int(btn_frm_active.height * (half_frm_w / btn_frm_active.width))), Image.LANCZOS)
    showcase.paste(frm_norm_scaled, (col1_x + 10, row_y[3] + 20), frm_norm_scaled)
    showcase.paste(frm_act_scaled, (col2_x + 10, row_y[3] + 20), frm_act_scaled)

    # Save showcase to brain directory for artifact embedding
    if ARTIFACTS.exists():
        showcase_path = ARTIFACTS / 'toggle_buttons_showcase.png'
        showcase.save(showcase_path, optimize=True)
        print(f'Saved showcase preview: {showcase_path}')

    # Also save in public/assets/images/
    showcase.save(SRC / 'toggle_buttons_showcase.jpg', quality=95)
    print('Finished all asset extractions successfully.')


if __name__ == '__main__':
    main()
