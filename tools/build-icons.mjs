/**
 * Generates the app icons (public/icons) from an SVG drawn here: a padel court seen from
 * behind the baseline, under floodlights, with the ball in flight.
 * Usage: node tools/build-icons.mjs
 */
import fs from 'node:fs';
import sharp from 'sharp';

/** `pad` shrinks the artwork towards the centre (maskable icons need a safe zone). */
function svg(pad) {
  const s = 1 - 2 * pad;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#040a16"/><stop offset="1" stop-color="#12305e"/>
    </linearGradient>
    <linearGradient id="court" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1b56b4"/><stop offset="1" stop-color="#2b7af0"/>
    </linearGradient>
    <radialGradient id="ball" cx="0.38" cy="0.34" r="0.75">
      <stop offset="0" stop-color="#f2ff7a"/><stop offset="0.6" stop-color="#d8ef2f"/><stop offset="1" stop-color="#9fb513"/>
    </radialGradient>
  </defs>
  <rect width="512" height="512" fill="url(#sky)"/>
  <g transform="translate(${256 * (1 - s)} ${256 * (1 - s)}) scale(${s})">
    <polygon points="150,214 362,214 470,452 42,452" fill="url(#court)"/>
    <g stroke="#ffffff" stroke-width="7" fill="none" stroke-linejoin="round">
      <line x1="256" y1="246" x2="256" y2="386"/>
      <line x1="135" y1="246" x2="377" y2="246"/>
      <line x1="72" y1="386" x2="440" y2="386"/>
    </g>
    <g>
      <rect x="110" y="296" width="292" height="30" fill="#0b1424" opacity="0.55"/>
      <rect x="110" y="292" width="292" height="8" rx="2" fill="#ffffff"/>
      <rect x="106" y="290" width="8" height="40" rx="2" fill="#0b1424"/>
      <rect x="398" y="290" width="8" height="40" rx="2" fill="#0b1424"/>
    </g>
    <path d="M 120 196 Q 250 20 372 150" stroke="#d8ef2f" stroke-width="7" fill="none" stroke-linecap="round" stroke-dasharray="2 18" opacity="0.8"/>
    <circle cx="372" cy="150" r="46" fill="url(#ball)"/>
    <path d="M 338 124 Q 372 150 344 184" stroke="#ffffff" stroke-width="6" fill="none" opacity="0.9"/>
    <path d="M 404 118 Q 380 150 402 180" stroke="#ffffff" stroke-width="6" fill="none" opacity="0.9"/>
  </g>
</svg>`;
}

fs.mkdirSync('public/icons', { recursive: true });
const jobs = [
  ['icon-192.png', 192, 0],
  ['icon-512.png', 512, 0],
  ['icon-maskable-512.png', 512, 0.1],
  ['apple-touch-icon.png', 180, 0.03],
];
for (const [name, size, pad] of jobs) {
  await sharp(Buffer.from(svg(pad))).resize(size, size).png({ compressionLevel: 9 }).toFile(`public/icons/${name}`);
  console.log('wrote', name);
}
