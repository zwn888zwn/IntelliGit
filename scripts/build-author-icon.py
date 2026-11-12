"""Generate the CodeLens icon font from the editable SVG (requires fonttools)."""
from pathlib import Path
from xml.etree import ElementTree
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.pens.transformPen import TransformPen
from fontTools.svgLib.path import parse_path

root = Path(__file__).resolve().parent.parent
svg = ElementTree.parse(root / "media/author-outline.svg")
pen = TTGlyphPen(None)
transformed = TransformPen(Cu2QuPen(pen, max_err=1), (64, 0, 0, -64, 0, 1024))
for element in svg.iter("{http://www.w3.org/2000/svg}path"):
    parse_path(element.attrib["d"], transformed)
font = FontBuilder(1024, isTTF=True)
font.setupGlyphOrder([".notdef", "author"])
font.setupCharacterMap({0xE001: "author"})
font.setupGlyf({".notdef": TTGlyphPen(None).glyph(), "author": pen.glyph()})
font.setupHorizontalMetrics({".notdef": (1024, 0), "author": (1024, 96)})
font.setupHorizontalHeader(ascent=1024, descent=0)
font.setupNameTable({"familyName": "IntelliGit Author", "styleName": "Regular", "uniqueFontIdentifier": "IntelliGitAuthor-1", "fullName": "IntelliGit Author", "psName": "IntelliGitAuthor"})
font.setupOS2(sTypoAscender=1024, sTypoDescender=0, usWinAscent=1024, usWinDescent=0)
font.setupPost()
font.setupMaxp()
font.font["head"].created = font.font["head"].modified = 2082844800
font.font.recalcTimestamp = False
font.font.flavor = "woff"
font.save(root / "media/author-outline.woff")
