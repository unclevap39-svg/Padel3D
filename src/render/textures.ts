/**
 * Procedural textures generated on canvases at start-up: no downloads, everything is code.
 */
import * as THREE from 'three';

function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  return [c, ctx];
}

/** Small deterministic PRNG so the textures are identical on every run. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Tileable value noise sampled on a wrapped grid. */
function tileNoise(size: number, cells: number, seed: number): Float32Array {
  const r = rng(seed);
  const grid = new Float32Array(cells * cells);
  for (let i = 0; i < grid.length; i++) grid[i] = r();
  const out = new Float32Array(size * size);
  const sm = (t: number) => t * t * (3 - 2 * t);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const fx = (x / size) * cells;
      const fy = (y / size) * cells;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const tx = sm(fx - x0);
      const ty = sm(fy - y0);
      const x1 = (x0 + 1) % cells;
      const y1 = (y0 + 1) % cells;
      const a = grid[y0 * cells + x0];
      const b = grid[y0 * cells + x1];
      const c = grid[y1 * cells + x0];
      const d = grid[y1 * cells + x1];
      out[y * size + x] = a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
    }
  }
  return out;
}

function finish(tex: THREE.Texture, repeat: number, srgb: boolean, aniso: number): THREE.Texture {
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.anisotropy = aniso;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/** Height field → tangent-space normal map. */
function normalFromHeight(h: Float32Array, size: number, strength: number): HTMLCanvasElement {
  const [c, ctx] = makeCanvas(size, size);
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const l = h[y * size + ((x - 1 + size) % size)];
      const r = h[y * size + ((x + 1) % size)];
      const u = h[((y - 1 + size) % size) * size + x];
      const d = h[((y + 1) % size) * size + x];
      const nx = (l - r) * strength;
      const ny = (u - d) * strength;
      const inv = 1 / Math.hypot(nx, ny, 1);
      const i = (y * size + x) * 4;
      img.data[i] = (nx * inv * 0.5 + 0.5) * 255;
      img.data[i + 1] = (ny * inv * 0.5 + 0.5) * 255;
      img.data[i + 2] = (inv * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

export interface TurfTextures {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
}

/**
 * Sand-filled synthetic turf: short fibres give a fine grain, sand shows as pale specks that
 * gather in patches, and play leaves broad lighter and darker areas.
 * White albedo so one set serves both the blue surface and the lines (tinted by material colour).
 */
export function createTurfTextures(aniso: number, size = 512): TurfTextures {
  const r = rng(1234);
  const broad = tileNoise(size, 4, 11);
  const mid = tileNoise(size, 24, 12);
  const sandPatch = tileNoise(size, 9, 13);
  const height = new Float32Array(size * size);
  const [c, ctx] = makeCanvas(size, size);
  const [rc, rctx] = makeCanvas(size, size);
  const img = ctx.createImageData(size, size);
  const rimg = rctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const fibre = r();
    const sandiness = Math.max(0, sandPatch[i] - 0.45) * 1.6;
    const isSand = r() < 0.05 + sandiness * 0.22;
    let v = 0.8 + (broad[i] - 0.5) * 0.14 + (mid[i] - 0.5) * 0.1 + (fibre - 0.5) * 0.2;
    let tintR = 1;
    let tintG = 1;
    let tintB = 1;
    if (isSand) {
      // Sand grains: pale, slightly warm, desaturating the turf colour.
      v = 1.12 + r() * 0.25;
      tintR = 1.25;
      tintG = 1.12;
      tintB = 0.82;
    }
    const k = i * 4;
    img.data[k] = Math.min(255, v * tintR * 200);
    img.data[k + 1] = Math.min(255, v * tintG * 200);
    img.data[k + 2] = Math.min(255, v * tintB * 200);
    img.data[k + 3] = 255;
    height[i] = fibre * 0.7 + (isSand ? 0.5 : 0) + mid[i] * 0.4;
    const rough = isSand ? 0.82 : 0.93 + (fibre - 0.5) * 0.08;
    rimg.data[k] = 255;
    rimg.data[k + 1] = rough * 255;
    rimg.data[k + 2] = 0;
    rimg.data[k + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  rctx.putImageData(rimg, 0, 0);
  return {
    map: finish(new THREE.CanvasTexture(c), 1, true, aniso),
    normalMap: finish(new THREE.CanvasTexture(normalFromHeight(height, size, 1.4)), 1, false, aniso),
    roughnessMap: finish(new THREE.CanvasTexture(rc), 1, false, aniso),
  };
}

/**
 * Welded wire mesh, 50 mm squares, wires drawn with a lit edge so they read as round steel.
 * One tile covers `cells` × `cells` squares.
 */
export function createFenceTexture(aniso: number, cells = 4, cell = 64): THREE.Texture {
  const size = cells * cell;
  const [c, ctx] = makeCanvas(size, size);
  ctx.clearRect(0, 0, size, size);
  const wire = Math.max(3, Math.round(cell * 0.11));
  for (let i = 0; i < cells; i++) {
    const p = i * cell + cell / 2;
    for (const vertical of [true, false]) {
      const g = vertical ? ctx.createLinearGradient(p - wire / 2, 0, p + wire / 2, 0) : ctx.createLinearGradient(0, p - wire / 2, 0, p + wire / 2);
      g.addColorStop(0, 'rgba(60,66,72,1)');
      g.addColorStop(0.35, 'rgba(200,208,214,1)');
      g.addColorStop(0.6, 'rgba(120,128,136,1)');
      g.addColorStop(1, 'rgba(44,48,54,1)');
      ctx.fillStyle = g;
      if (vertical) ctx.fillRect(p - wire / 2, 0, wire, size);
      else ctx.fillRect(0, p - wire / 2, size, wire);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  finish(tex, 1, true, aniso);
  return tex;
}

/** Knotted black net, 45 mm squares on the diagonal-free weave used for padel. */
export function createNetTexture(aniso: number): THREE.Texture {
  const cell = 32;
  const cells = 4;
  const size = cell * cells;
  const [c, ctx] = makeCanvas(size, size);
  ctx.clearRect(0, 0, size, size);
  ctx.strokeStyle = 'rgba(12,12,14,1)';
  ctx.lineWidth = 3.2;
  for (let i = 0; i < cells; i++) {
    const p = i * cell + cell / 2;
    ctx.beginPath();
    ctx.moveTo(p, 0);
    ctx.lineTo(p, size);
    ctx.moveTo(0, p);
    ctx.lineTo(size, p);
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(8,8,10,1)';
  for (let i = 0; i < cells; i++)
    for (let j = 0; j < cells; j++) {
      ctx.beginPath();
      ctx.arc(i * cell + cell / 2, j * cell + cell / 2, 3.2, 0, Math.PI * 2);
      ctx.fill();
    }
  return finish(new THREE.CanvasTexture(c), 1, true, aniso);
}

/** Ball: optic-yellow felt with the white rubber seam, as an equirectangular map plus a fuzz normal map. */
export function createBallTextures(color = 0xd0e828): { map: THREE.Texture; normalMap: THREE.Texture } {
  const feltR = (color >> 16) & 255;
  const feltG = (color >> 8) & 255;
  const feltB = color & 255;
  const w = 256;
  const h = 128;
  const [c, ctx] = makeCanvas(w, h);
  const r = rng(77);
  const img = ctx.createImageData(w, h);
  // Seam: the classic curve x = a cos t + b cos 3t, y = a sin t - b sin 3t, z = c sin 2t on the sphere.
  const seam: Array<[number, number, number]> = [];
  const A = 0.72;
  const B = 0.28;
  const C = 2 * Math.sqrt(A * B);
  for (let i = 0; i < 400; i++) {
    const t = (i / 400) * Math.PI * 2;
    const x = A * Math.cos(t) + B * Math.cos(3 * t);
    const y = A * Math.sin(t) - B * Math.sin(3 * t);
    const z = C * Math.sin(2 * t);
    const l = Math.hypot(x, y, z);
    seam.push([x / l, y / l, z / l]);
  }
  const height = new Float32Array(w * h);
  for (let py = 0; py < h; py++) {
    const lat = (0.5 - (py + 0.5) / h) * Math.PI;
    for (let px = 0; px < w; px++) {
      const lon = ((px + 0.5) / w) * Math.PI * 2;
      const dx = Math.cos(lat) * Math.cos(lon);
      const dy = Math.sin(lat);
      const dz = Math.cos(lat) * Math.sin(lon);
      let best = -1;
      for (const s of seam) {
        const d = dx * s[0] + dy * s[1] + dz * s[2];
        if (d > best) best = d;
      }
      const ang = Math.acos(Math.min(1, best));
      const seamMix = 1 - Math.min(1, Math.max(0, (ang - 0.045) / 0.03));
      const fuzz = r();
      const v = 0.9 + (fuzz - 0.5) * 0.22;
      const k = (py * w + px) * 4;
      img.data[k] = Math.min(255, feltR * v) * (1 - seamMix) + 236 * seamMix;
      img.data[k + 1] = Math.min(255, feltG * v) * (1 - seamMix) + 236 * seamMix;
      img.data[k + 2] = Math.min(255, feltB * v) * (1 - seamMix) + 224 * seamMix;
      img.data[k + 3] = 255;
      height[py * w + px] = fuzz * (1 - seamMix) + seamMix * -1.5;
    }
  }
  ctx.putImageData(img, 0, 0);
  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace;
  // Normal map built on a square canvas from the same fuzz field.
  const sq = new Float32Array(w * w);
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) sq[y * w + x] = height[Math.floor((y / w) * h) * w + x];
  const normalMap = new THREE.CanvasTexture(normalFromHeight(sq, w, 1.2));
  return { map, normalMap };
}

/**
 * Spectators seen from afar under stadium light: rows of seats, most of them occupied by a
 * head-and-shoulders silhouette in muted clothing colours.
 */
export function createCrowdTexture(): THREE.Texture {
  const w = 512;
  const h = 256;
  const [c, ctx] = makeCanvas(w, h);
  const r = rng(4242);
  ctx.fillStyle = '#0a0d14';
  ctx.fillRect(0, 0, w, h);
  const rows = 10;
  const cols = 44;
  const rh = h / rows;
  const cw = w / cols;
  const palette = ['#39465e', '#5a4a44', '#2c3a4a', '#6a6f7a', '#45303a', '#27425a', '#7a7468', '#30343c', '#56627a', '#8a8f98'];
  for (let j = 0; j < rows; j++) {
    const y = j * rh;
    // Seat row and the shadowed step behind it.
    ctx.fillStyle = '#10141d';
    ctx.fillRect(0, y, w, rh);
    ctx.fillStyle = '#181e2a';
    ctx.fillRect(0, y + rh * 0.78, w, rh * 0.22);
    for (let i = 0; i < cols; i++) {
      if (r() < 0.14) continue; // empty seat
      const cx = i * cw + cw / 2 + (r() - 0.5) * cw * 0.25;
      const base = y + rh * 0.8;
      ctx.fillStyle = palette[Math.floor(r() * palette.length)];
      ctx.beginPath();
      ctx.ellipse(cx, base - rh * 0.12, cw * 0.4, rh * 0.3, 0, Math.PI, 0);
      ctx.fill();
      const skin = 120 + r() * 90;
      ctx.fillStyle = `rgb(${skin},${skin * 0.8},${skin * 0.68})`;
      ctx.beginPath();
      ctx.arc(cx, base - rh * 0.46, cw * 0.19, 0, Math.PI * 2);
      ctx.fill();
      if (r() < 0.75) {
        const hair = 20 + r() * 60;
        ctx.fillStyle = `rgb(${hair},${hair * 0.85},${hair * 0.7})`;
        ctx.beginPath();
        ctx.arc(cx, base - rh * 0.5, cw * 0.2, Math.PI, 0);
        ctx.fill();
      }
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Perimeter LED board: a generic sponsor-style panel carrying the game's own name. */
export function createBoardTexture(text: string, bg: string, fg: string): THREE.Texture {
  const [c, ctx] = makeCanvas(1024, 128);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 1024, 128);
  ctx.fillStyle = fg;
  ctx.font = '800 76px system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 256, 68);
  ctx.fillText(text, 768, 68);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

/** Soft round blob used for contact shadows and light glows. */
export function createBlobTexture(inner = 0.0, power = 1.6): THREE.Texture {
  const s = 128;
  const [c, ctx] = makeCanvas(s, s);
  const img = ctx.createImageData(s, s);
  for (let y = 0; y < s; y++)
    for (let x = 0; x < s; x++) {
      const d = Math.hypot(x - s / 2 + 0.5, y - s / 2 + 0.5) / (s / 2);
      const a = d <= inner ? 1 : Math.pow(Math.max(0, 1 - (d - inner) / (1 - inner)), power);
      const k = (y * s + x) * 4;
      img.data[k] = img.data[k + 1] = img.data[k + 2] = 255;
      img.data[k + 3] = a * 255;
    }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
