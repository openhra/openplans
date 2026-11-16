export const ADMIN_STYLES = `
:root { color-scheme:light dark; --bg:#fff; --fg:#1a1a1a; --muted:#555; --line:#ccc; --accent:#006b65; }
@media (prefers-color-scheme:dark) { :root { --bg:#121212; --fg:#eee; --muted:#b8b8b8; --line:#444; --accent:#64d8ca; } }
* { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.5 system-ui,sans-serif; }
header,main { max-width:76rem; margin:auto; padding:1rem; } nav ul { display:flex; flex-wrap:wrap; gap:.5rem 1rem; padding:0; list-style:none; }
a { color:var(--accent); } nav a,button { display:inline-block; min-height:44px; padding:.5rem; } :focus-visible { outline:3px solid var(--accent); outline-offset:2px; }
.skip { position:absolute; left:-10000px; } .skip:focus { left:1rem; background:var(--bg); }
.unknown { color:var(--muted); } section { padding:1rem 0; border-top:1px solid var(--line); } p { overflow-wrap:anywhere; }
@media (max-width:30rem) { header,main { padding:.75rem; } }
`;
