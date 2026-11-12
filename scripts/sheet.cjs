// Dev helper: tile screenshots into one contact sheet. Usage: node scripts/sheet.cjs out.png cols cropW,cropH,cropX,cropY in1 in2 ...
const sharp = require('sharp');
(async () => {
  const [out, cols, crop, ...files] = process.argv.slice(2);
  const [w, h, x, y] = crop.split(',').map(Number);
  const tiles = await Promise.all(files.map((f) => sharp(f).extract({ left: x, top: y, width: w, height: h }).toBuffer()));
  const n = Number(cols);
  const rows = Math.ceil(tiles.length / n);
  await sharp({ create: { width: w * n, height: h * rows, channels: 3, background: '#000' } })
    .composite(tiles.map((input, i) => ({ input, left: (i % n) * w, top: Math.floor(i / n) * h })))
    .png()
    .toFile(out);
  console.log('saved', out);
})();
