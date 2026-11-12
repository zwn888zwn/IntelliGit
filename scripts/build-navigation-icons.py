"""Convert Apache-licensed JetBrains navigation SVGs to a native CodeLens font."""
from pathlib import Path
import re
from xml.etree import ElementTree
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.pens.transformPen import TransformPen
from fontTools.svgLib.path import parse_path

root = Path(__file__).resolve().parent.parent
names = ['implementing', 'implemented', 'overriding', 'overridden', 'recursive']
glyphs = {'.notdef': TTGlyphPen(None).glyph()}
for name in names:
    svg = ElementTree.parse(root / 'media/navigation' / (name + '.svg'))
    size = float(svg.getroot().attrib['viewBox'].split()[2])
    offset = (16 - size) / 2
    pen = TTGlyphPen(None)
    target = TransformPen(Cu2QuPen(pen, max_err=1), (64, 0, 0, -64, offset * 64, (16 - offset) * 64))
    for element in svg.iter():
        if element.attrib.get('fill', '').lower() in ['#f2fcf3', '#edf3ff']:
            continue  # Native CodeLens must remain transparent on every theme.
        kind = element.tag.split('}')[-1]
        if kind == 'path':
            parse_path(element.attrib['d'], target)
        elif kind == 'circle':
            x, y, r = (float(element.attrib[key]) for key in ['cx', 'cy', 'r'])
            k = r * 0.5522847498
            target.moveTo((x + r, y))
            target.curveTo((x + r, y + k), (x + k, y + r), (x, y + r))
            target.curveTo((x - k, y + r), (x - r, y + k), (x - r, y))
            target.curveTo((x - r, y - k), (x - k, y - r), (x, y - r))
            target.curveTo((x + k, y - r), (x + r, y - k), (x + r, y))
            target.closePath()
        elif kind == 'polygon':
            points = [float(value) for value in re.split(r'[\s,]+', element.attrib['points'].strip())]
            target.moveTo(tuple(points[:2]))
            for i in range(2, len(points), 2):
                target.lineTo(tuple(points[i:i+2]))
            target.closePath()
    glyphs[name] = pen.glyph()
font = FontBuilder(1024, isTTF=True)
font.setupGlyphOrder(['.notdef'] + names)
font.setupCharacterMap({0xE001 + index: name for index, name in enumerate(names)})
font.setupGlyf(glyphs)
font.setupHorizontalMetrics({name: (1024, 0) for name in glyphs})
font.setupHorizontalHeader(ascent=1024, descent=0)
font.setupNameTable({'familyName': 'IntelliGit Navigation', 'styleName': 'Regular',
    'uniqueFontIdentifier': 'IntelliGitNavigation-1', 'fullName': 'IntelliGit Navigation',
    'psName': 'IntelliGitNavigation', 'copyright': 'Copyright 2000-2024 JetBrains s.r.o. and contributors; Apache-2.0; font adaptation by IntelliGit'})
font.setupOS2(sTypoAscender=1024, sTypoDescender=0, usWinAscent=1024, usWinDescent=0)
font.setupPost()
font.setupMaxp()
font.font['head'].created = font.font['head'].modified = 2082844800
font.font.recalcTimestamp = False
font.font.flavor = 'woff'
font.save(root / 'media/navigation/navigation.woff')
