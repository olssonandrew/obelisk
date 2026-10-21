# App icons

The vector master is `../renderer/favicon.svg`, also used in the sidebar and README.
`icon.png` is its 1024px rendering; `icon.ico` contains Windows sizes from 16 to 256px.

macOS uses `icon-macos.png` for the Dock and `icon.icns` for the app bundle. Both
have an 824px artwork area centered in a transparent 1024px canvas (100px margin
on each side). Preserve this margin: full-bleed artwork appears oversized in the
Dock. The obelisk itself remains cropped at the bottom of its purple background.

To regenerate, render the vector with a 100px translation and a 1.609375 scale
from its 512px viewBox. Generate the standard macOS iconset sizes from that PNG
and convert with `iconutil`. Keep the unpadded SVG for in-app and README use.
