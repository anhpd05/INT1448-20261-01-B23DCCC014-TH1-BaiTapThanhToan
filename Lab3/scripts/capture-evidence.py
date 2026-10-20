import datetime
import pathlib
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFont

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "evidence"
SCENARIOS = ["tc1", "tc2", "tc3", "tc4a", "tc4b", "tc4c"]
MODES = [("sau", []), ("truoc", ["--naive"])]

FONT = ImageFont.truetype("C:/Windows/Fonts/consola.ttf", 16)
FONT_BOLD = ImageFont.truetype("C:/Windows/Fonts/consolab.ttf", 16)
LINE_H = 22
PAD = 18
BG = (30, 30, 30)
FG = (212, 212, 212)
DIM = (140, 140, 140)
GREEN = (78, 201, 120)
RED = (244, 94, 94)
CYAN = (86, 182, 194)


def color_of(line):
    if line.startswith("PASS"):
        return GREEN, FONT_BOLD
    if line.startswith("FAIL"):
        return RED, FONT_BOLD
    if line.startswith("$"):
        return CYAN, FONT_BOLD
    if line.startswith("==="):
        return FG, FONT_BOLD
    if line.startswith("#"):
        return DIM, FONT
    return FG, FONT


def render(lines, path):
    width = int(max(FONT.getlength(l) for l in lines)) + PAD * 2
    height = LINE_H * len(lines) + PAD * 2
    img = Image.new("RGB", (max(width, 640), height), BG)
    draw = ImageDraw.Draw(img)
    for i, line in enumerate(lines):
        color, font = color_of(line)
        draw.text((PAD, PAD + i * LINE_H), line, fill=color, font=font)
    img.save(path)


def main():
    OUT.mkdir(exist_ok=True)
    node = subprocess.run(["node", "-v"], capture_output=True, text=True).stdout.strip()
    stamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    for tc in SCENARIOS:
        for label, extra in MODES:
            cmd = ["npm", "run", "scenario", "--", tc, *extra]
            shown = "npm run scenario -- " + " ".join([tc, *extra]).strip()
            print(f"[{tc} {label}] {shown}", flush=True)
            proc = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, encoding="utf-8", shell=True)
            body = (proc.stdout + proc.stderr).strip("\n").splitlines()
            header = [f"# {stamp}  node {node}  exit={proc.returncode}", f"$ {shown}"]
            lines = header + body
            name = f"{tc}-{label}"
            (OUT / f"{name}.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
            render(lines, OUT / f"{name}.png")
    print(f"Xong: {OUT}")


if __name__ == "__main__":
    sys.exit(main())
