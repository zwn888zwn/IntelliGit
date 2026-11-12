# JetBrains navigation icons

Copyright 2000–2024 JetBrains s.r.o. and contributors.
Licensed under the Apache License, Version 2.0 (see LICENSE.txt).

Source: IntelliJ Platform icon assets, bundled in GoLand's
`intellij.platform.icons.jar`. Original copyright notices are retained in the SVGs.

- implementing.svg: expui/gutter/implementingMethod.svg
- implemented.svg: expui/gutter/implementedMethod.svg
- overriding.svg: expui/general/overridingMethod.svg
- overridden.svg: expui/general/overriddenMethod.svg
- recursive.svg: gutter/recursiveMethod.svg

IntelliGit converts these shapes into navigation.woff for native CodeLens icons.
The font removes background fills and uses the editor's foreground color;
geometry is scaled and centered in a 16-pixel box. The SVG sources are unchanged.
Regenerate with scripts/build-navigation-icons.py (fonttools required).
