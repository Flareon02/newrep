#!/usr/bin/env python3
"""Builds extension/game-icons.css: one CSS-mask glyph per game (simple generic shapes, local, no remote assets).
Each icon is a single <span class="game-icon gi-KEY" data-glyph> tinted by --gc-KEY (defined for dark and light)."""
import pathlib, urllib.parse
S = "stroke='black' stroke-linecap='round' stroke-linejoin='round' fill='none'"
G = {
 'cs':        (f"<circle cx='12' cy='12' r='6.5' {S} stroke-width='2.2'/><path d='M12 1.8v5.4M12 16.8v5.4M1.8 12h5.4M16.8 12h5.4' {S} stroke-width='2.2'/><circle cx='12' cy='12' r='1.7'/>", '#e8a33d', '#a05f00'),
 'dota':      (f"<rect x='3.5' y='3.5' width='17' height='17' rx='2.5' {S} stroke-width='2.2'/><path d='M7.5 16.5l9-9' {S} stroke-width='2.8'/><path d='M7.5 7.5h3M16.5 16.5h-3' {S} stroke-width='2.2'/>", '#f06a5f', '#bf3328'),
 'lol':       (f"<path d='M12 2.2 20.6 7v10L12 21.8 3.4 17V7z' {S} stroke-width='2'/><path d='M9.6 7.6v8.8h5.2' {S} stroke-width='2.3'/>", '#d2b57a', '#8a6a26'),
 'wildrift':  (f"<path d='M12 2.2 20.6 7v10L12 21.8 3.4 17V7z' {S} stroke-width='2'/><path d='M8 8.5l2 7 2-5 2 5 2-7' {S} stroke-width='1.9'/>", '#6fd6e0', '#137f8a'),
 'valorant':  ("<path d='M2.8 5h3.8l7.6 14h-3.6z'/><path d='M21.2 5l-5.6 9h-3.9L17.4 5z'/>", '#ff6273', '#c8263b'),
 'overwatch': (f"<path d='M6.3 5.6A8.6 8.6 0 1 0 17.7 5.6' {S} stroke-width='2.4'/><path d='M8.4 8.2 12 14l3.6-5.8' {S} stroke-width='2.4'/>", '#f9a227', '#b06600'),
 'hearthstone':("<path d='M12 2.4c1.6 3.3 5.7 5.7 5.7 10.4A5.7 5.7 0 0 1 6.3 13c0-2.3 1-3.8 2.4-5 .2 1.6.9 2.7 2.1 3.2-.4-3.3.3-6.1 1.2-8.8z'/>", '#f5bb4b', '#a36a00'),
 'honor':     ("<path d='M3.2 8l4.2 3.6L12 4.8l4.6 6.8 4.2-3.6-1.9 10.2H5.1z'/><rect x='5.1' y='19.2' width='13.8' height='2.2' rx='.7'/>", '#e0bb63', '#8d6716'),
 'heroes':    ("<path d='M4.5 21.5V7.5h2.8v2.3h2.3V7.5h4.8v2.3h2.3V7.5h2.8v14h-5.3v-4.7a2.2 2.2 0 0 0-4.4 0v4.7z'/>", '#cfa86b', '#7d5a1f'),
 'rainbow':   (f"<path d='M12 2.4 20 5.4v6.2c0 5-3.4 8.6-8 10-4.6-1.4-8-5-8-10V5.4z' {S} stroke-width='2.2'/><circle cx='12' cy='12.2' r='3.1' {S} stroke-width='2.1'/>", '#94b5dc', '#3b6496'),
 'mobile':    (f"<path d='M4.5 4.5l9.2 9.2M19.5 4.5l-9.2 9.2' {S} stroke-width='2.5'/><path d='M6.5 14.5l3 3M17.5 14.5l-3 3M7.5 17.5 4 21M16.5 17.5 20 21' {S} stroke-width='2.2'/>", '#6ea6ff', '#2a5cc4'),
 'rocket':    (f"<circle cx='12' cy='12' r='8.6' {S} stroke-width='2.2'/><path d='M12 7.4l3.9 2.8-1.5 4.6H9.6L8.1 10.2z'/>", '#52b6ff', '#1a6cb5'),
 'arena':     (f"<path d='M18.6 3.2H21v2.4L10.2 16.4l-2.6-2.6z'/><path d='M5.2 14.2l4.6 4.6M3.8 20.2l3-3' {S} stroke-width='2.3'/>", '#ff9759', '#bf5016'),
 'standoff':  ("<path d='M2.8 6.8h17.4v4.3h-6.1l-1 2.1h-3.2l-1.3 6.2H4.4l1.5-8.3H2.8z'/>", '#ffbd57', '#a36a00'),
 'starcraft': ("<path d='M12 2.2l2.7 6.3 6.8.6-5.2 4.5 1.6 6.8L12 16.8l-5.9 3.6 1.6-6.8-5.2-4.5 6.8-.6z'/>", '#72d3ff', '#167bab'),
 'aoe':       (f"<path d='M5.2 21.5V2.8' {S} stroke-width='2.3'/><path d='M6.3 3.6h12.5l-3.1 4.2 3.1 4.2H6.3z'/>", '#d8aa5e', '#86601b'),
 'warcraft':  (f"<path d='M13.6 2.6a7.4 7.4 0 0 1 7.6 7.6h-5.8L13.6 8.6z'/><path d='M15 9.2 3.8 20.4' {S} stroke-width='2.5'/>", '#f4a843', '#a3600a'),
 'tanks':     (f"<path d='M2.6 15.2h18.8l-2.2 4.9H4.8z'/><path d='M6.6 14.6v-4.2h9.6v4.2z'/><path d='M14.6 12.3h7.4' {S} stroke-width='2.1'/>", '#a8bd70', '#52671f'),
 'cod':       ("<path d='M3.6 5.6l8.4 5.2 8.4-5.2v3.7L12 14.5 3.6 9.3zM3.6 12.4l8.4 5.2 8.4-5.2v3.7L12 21.3l-8.4-5.2z'/>", '#b0b8c2', '#4a5563'),
 'pubg':      (f"<path d='M2.8 11a9.2 9.2 0 0 1 18.4 0z'/><path d='M3.8 11.6 12 19.2l8.2-7.6M12 11v8.2' {S} stroke-width='1.7'/><rect x='10.4' y='18.6' width='3.2' height='3.2' rx='.7'/>", '#f4c552', '#946e00'),
 'quake':     (f"<circle cx='12' cy='10.6' r='7' {S} stroke-width='2.5'/><path d='M12 17.6v4.2M8.6 6.6 12 10.6l3.4-4' {S} stroke-width='2.2'/>", '#cc7452', '#8a3a1c'),
 'cf':        ("<path d='M9.9 2.6h4.2v7.3h7.3v4.2h-7.3v7.3H9.9v-7.3H2.6V9.9h7.3z'/>", '#ef5a50', '#b0261d'),
 'fc':        (f"<circle cx='12' cy='12' r='9' {S} stroke-width='2'/><path d='M12 7.4l3.9 2.8-1.5 4.6H9.6L8.1 10.2z'/><path d='M12 3v4.4M20.6 9.4l-4.7.8M17.3 19.1l-2.9-4.3M6.7 19.1l2.9-4.3M3.4 9.4l4.7.8' {S} stroke-width='1.6'/>", '#4ccd78', '#1b8448'),
 'basketball':(f"<circle cx='12' cy='12' r='9' {S} stroke-width='2'/><path d='M3 12h18M12 3v18M5.7 5.7a9 9 0 0 1 0 12.6M18.3 5.7a9 9 0 0 0 0 12.6' {S} stroke-width='1.7'/>", '#ff8e45', '#bd5214'),
 'apex':      ("<path d='M12 2.4 21.6 20.2h-5.1L12 11.4l-4.5 8.8H2.4z'/><path d='M9.3 20.2 12 15l2.7 5.2z'/>", '#ff6052', '#bd2b1f'),
 'tft':       (f"<path d='M12 2.6l8.2 4.7v9.4L12 21.4l-8.2-4.7V7.3z' {S} stroke-width='2'/><path d='M12 7.2l4.1 2.4v4.8L12 16.8l-4.1-2.4V9.6z'/>", '#c7a0ff', '#6d40c4'),
 'other':     ("<path fill-rule='evenodd' d='M7.2 7.6h9.6a5.2 5.2 0 0 1 4.8 7.2l-.7 1.7a2.6 2.6 0 0 1-4.3.8l-2.1-2.3H9.5l-2.1 2.3a2.6 2.6 0 0 1-4.3-.8l-.7-1.7a5.2 5.2 0 0 1 4.8-7.2zM7 10v1.6H5.4v1.6H7v1.6h1.6v-1.6h1.6v-1.6H8.6V10zm8.6.3a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2zm2.2 2.1a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2z'/>", '', ''),
}
def uri(body):
    svg = f"<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'>{body}</svg>"
    return 'url("data:image/svg+xml,' + urllib.parse.quote(svg, safe="=:/' ") + '")'
dark = ';'.join(f'--gc-{k}:{d}' for k, (_, d, l) in G.items() if d)
light = ';'.join(f'--gc-{k}:{l}' for k, (_, d, l) in G.items() if l)
out = ["/* Generated by tools/ux/build-game-icons.py - game glyphs as CSS masks (one node per icon, themed through --gc-*). */",
       f":root{{{dark}}}", f":root[data-theme=\"light\"]{{{light}}}",
       ".game-icon{--gc:var(--gi-fg);position:relative;display:inline-grid;place-items:center;width:24px;height:24px;border-radius:6px;background:color-mix(in srgb,var(--gc) 17%,var(--raised));color:var(--gc);font-size:10px;font-weight:700;line-height:1;flex:none;letter-spacing:-.02em;overflow:hidden;user-select:none}",
       ".game-icon[data-glyph]{font-size:0!important;color:var(--gc)}",
       ".game-icon[data-glyph]::before{content:'';position:absolute;inset:15%;background:currentColor;-webkit-mask:var(--glyph) center/contain no-repeat;mask:var(--glyph) center/contain no-repeat}"]
for k, (body, d, l) in G.items():
    out.append(f".gi-{k}{{{'--gc:var(--gc-'+k+');' if d else ''}--glyph:{uri(body)}}}")
p = pathlib.Path(__file__).resolve().parents[2] / 'extension' / 'game-icons.css'
p.write_text('\n'.join(out) + '\n')
print(p, len(G), 'icons', p.stat().st_size, 'bytes')
