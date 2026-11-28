// The source of the icons in web/public: apple-touch-icon.png (180, edge to edge: the system rounds it),
// icon-192.png and icon-512.png (the rounded tile of mark.svg), and the 16 and 32 pixel PNGs inside
// favicon.ico. They are not built: to make them again, run this in a Chromium page's console (about:blank
// will do). It returns the PNGs as data URLs; favicon.ico is an ICO directory holding the two small PNGs.
(async () => {
  // The tile (MARK_TILE_PATH in web/src/components/Icons.tsx) in the accent, its cut-outs left clear.
  const path = "M7 2h14a5 5 0 0 1 5 5v14a5 5 0 0 1-5 5H7a5 5 0 0 1-5-5V7a5 5 0 0 1 5-5Zm5 5.5a5.5 5.5 0 1 0 0 11h14v-2.6h-9.4A5.5 5.5 0 0 0 12 7.5Zm0 3.3a2.2 2.2 0 1 1 0 4.4a2.2 2.2 0 0 1 0-4.4Z";
  const tile = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="2 2 24 24"><path fill="#cfdb6e" fill-rule="evenodd" d="${path}"/></svg>`;
  // Edge to edge for iOS, which rounds it: the accent field with the drum and line cut in graphite.
  const cut = "M12 7.5a5.5 5.5 0 1 0 0 11h16v-2.6h-11.4A5.5 5.5 0 0 0 12 7.5Zm0 3.3a2.2 2.2 0 1 1 0 4.4a2.2 2.2 0 0 1 0-4.4Z";
  const bleed = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="1 1 26 26"><rect x="0" y="0" width="28" height="28" fill="#cfdb6e"/><path fill="#15161a" fill-rule="evenodd" d="${cut}"/></svg>`;
  const draw = (svg, size) => new Promise((done) => {
    const image = new Image();
    image.onload = () => { const c = document.createElement("canvas"); c.width = c.height = size; c.getContext("2d").drawImage(image, 0, 0, size, size); done(c.toDataURL("image/png")); };
    image.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  });
  return JSON.stringify({ "mark-svg": tile, "apple-touch-icon": await draw(bleed, 180), "icon-192": await draw(tile, 192), "icon-512": await draw(tile, 512), "fav-32": await draw(tile, 32), "fav-16": await draw(tile, 16) });
})()
