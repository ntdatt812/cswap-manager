"""Builds media/usage-bars.woff: the slanted usage-bar cells used as `$(cswap-slant-N)` icons.

Unicode has only a full (U+25B0) and an empty (U+25B1) parallelogram, so a text bar in that style can
only show whole cells. These nine glyphs add the eighths in between: `cswap-slant-0` is an empty
outline, `cswap-slant-8` a full cell, and 1-7 fill that many eighths from the left with a cut that
follows the slant. Proportions follow Segoe UI Symbol's U+25B0/U+25B1 at 13 px, scaled for VS Code's
16 px icon size; like the codicon font, the em box sits on the baseline and shapes are centred in it.

Development only (needs fontTools: `python -m pip install fonttools`). Run from the repository root:
    python scripts/build-usage-bar-icons.py
"""

from pathlib import Path

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

UPM = 1000
ADVANCE = 812
HEIGHT = 476
WIDTH = 681  # bottom edge
SLANT = 100  # top edge shifted right by this much
STROKE = 60  # outline thickness of a cell's empty part
LEFT = (ADVANCE - WIDTH - SLANT) // 2
BOTTOM = (UPM - HEIGHT) // 2
TOP = BOTTOM + HEIGHT
FIRST_CODEPOINT = 0xE000
OUTPUT = Path(__file__).resolve().parent.parent / 'media' / 'usage-bars.woff'


def x_on_left_edge(y: float, inset: float = 0) -> float:
    return LEFT + inset + SLANT * (y - BOTTOM) / HEIGHT


def polygon(pen: TTGlyphPen, points: list[tuple[float, float]]) -> None:
    pen.moveTo((round(points[0][0]), round(points[0][1])))
    for x, y in points[1:]:
        pen.lineTo((round(x), round(y)))
    pen.closePath()


def cell(eighths: int):
    pen = TTGlyphPen(None)
    inset = STROKE / (HEIGHT / (HEIGHT**2 + SLANT**2) ** 0.5)  # horizontal inset for a slanted edge
    if eighths < 8:
        # Outline ring: outer contour clockwise, hole counter-clockwise (TrueType, y up).
        polygon(pen, [(x_on_left_edge(BOTTOM), BOTTOM), (x_on_left_edge(TOP), TOP), (x_on_left_edge(TOP) + WIDTH, TOP), (x_on_left_edge(BOTTOM) + WIDTH, BOTTOM)])
        low, high = BOTTOM + STROKE, TOP - STROKE
        polygon(
            pen,
            [
                (x_on_left_edge(low, inset), low),
                (x_on_left_edge(low, -inset) + WIDTH, low),
                (x_on_left_edge(high, -inset) + WIDTH, high),
                (x_on_left_edge(high, inset), high),
            ],
        )
    if eighths > 0:
        # Measured inside the outline, so even one eighth shows past the left stroke.
        filled = WIDTH if eighths == 8 else inset + (WIDTH - 2 * inset) * eighths / 8
        polygon(pen, [(x_on_left_edge(BOTTOM), BOTTOM), (x_on_left_edge(TOP), TOP), (x_on_left_edge(TOP) + filled, TOP), (x_on_left_edge(BOTTOM) + filled, BOTTOM)])
    return pen.glyph()


def main() -> None:
    names = [f'slant{k}' for k in range(9)]
    builder = FontBuilder(UPM, isTTF=True)
    builder.setupGlyphOrder(['.notdef', *names])
    builder.setupCharacterMap({FIRST_CODEPOINT + k: name for k, name in enumerate(names)})
    glyphs = {'.notdef': TTGlyphPen(None).glyph(), **{name: cell(k) for k, name in enumerate(names)}}
    builder.setupGlyf(glyphs)
    builder.setupHorizontalMetrics({name: (ADVANCE if name != '.notdef' else UPM, glyphs[name].xMin if hasattr(glyphs[name], 'xMin') else 0) for name in glyphs})
    builder.setupHorizontalHeader(ascent=UPM, descent=0)
    builder.setupNameTable({'familyName': 'Cswap Usage Bars', 'styleName': 'Regular'})
    builder.setupOS2(sTypoAscender=UPM, sTypoDescender=0, sTypoLineGap=0, usWinAscent=UPM, usWinDescent=0)
    builder.setupPost()
    builder.font.flavor = 'woff'
    OUTPUT.parent.mkdir(exist_ok=True)
    builder.save(str(OUTPUT))
    print(f'wrote {OUTPUT} ({OUTPUT.stat().st_size} bytes)')


if __name__ == '__main__':
    main()
