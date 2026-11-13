/**
 * Builds the player model (public/models/player.glb) from MakeHuman's CC0 assets:
 * base mesh + morph targets + game-engine rig and weights + clothes, shoes, hair and eyes.
 *
 * Usage: node tools/build-character.mjs <dir with the MakeHuman data> [out.glb]
 * See tools/README.md for where each input file comes from and its licence.
 *
 * Conventions: MakeHuman units are decimetres, y up, the character faces +z and +x is its left —
 * the same axes as glTF. Every bone is exported with an identity rest orientation (translation
 * only): the game computes world rotations itself, so bone roll does not matter.
 */
import { Document, NodeIO } from '@gltf-transform/core';
import { EXTTextureWebP, KHRDracoMeshCompression } from '@gltf-transform/extensions';
import { dedup, draco, prune } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const DATA = process.argv[2];
if (!DATA) {
  console.error('usage: node tools/build-character.mjs <makehuman data dir> [out.glb | --roster]');
  process.exit(1);
}
const P = {
  mh: path.join(DATA, 'makehuman'), // makehuman/data from the main repository
  mpfb: path.join(DATA, 'mpfb'), // mpfb2 src/mpfb/data
  assets: path.join(DATA, 'assets'), // makehuman-assets base/ (text files)
  tex: path.join(DATA, 'textures'), // makehuman-assets base/ (PNG textures)
};
const read = (p) => fs.readFileSync(p, 'utf8');
const DM = 0.1; // decimetres → metres

// ------------------------------------------------------------------------------------------------
// Base mesh

function parseObj(text) {
  const v = [];
  const vt = [];
  const faces = []; // { group, verts: [[vi, ti], ...] }
  let group = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('v ')) {
      const p = line.split(/\s+/);
      v.push([+p[1], +p[2], +p[3]]);
    } else if (line.startsWith('vt ')) {
      const p = line.split(/\s+/);
      vt.push([+p[1], +p[2]]);
    } else if (line.startsWith('g ')) {
      group = line.slice(2).trim();
    } else if (line.startsWith('f ')) {
      const p = line.trim().split(/\s+/).slice(1);
      faces.push({
        group,
        verts: p.map((s) => {
          const [a, b] = s.split('/');
          return [parseInt(a, 10) - 1, b ? parseInt(b, 10) - 1 : -1];
        }),
      });
    }
  }
  return { v, vt, faces };
}

function applyTarget(v, file, weight) {
  for (const line of read(file).split('\n')) {
    if (!line || line[0] === '#') continue;
    const p = line.trim().split(/\s+/);
    if (p.length < 4) continue;
    const i = +p[0];
    v[i][0] += +p[1] * weight;
    v[i][1] += +p[2] * weight;
    v[i][2] += +p[3] * weight;
  }
}

async function webp(input, size, quality, alpha = false) {
  let img = sharp(input).resize(size, size, { fit: 'fill' });
  if (!alpha) img = img.removeAlpha();
  return img.webp({ quality, alphaQuality: 90, effort: 6 }).toBuffer();
}

/**
 * Builds one character. `spec`:
 *   targets  [[file under makehuman/targets, weight], ...] morphs applied to the base mesh
 *   scale    overall size (1 = as modelled)
 *   hair     hair style folder under assets/hair, or null for a shaved head
 *   skin     file name of the skin texture, without `.png`
 *   lean     true: leave out the textures every character shares (suit, shoes, eyes) and
 *            store a neutral grey hair texture the game tints; the game takes the shared
 *            textures from the base model.
 */
async function build(spec, OUT) {
console.log(`\n== ${spec.id ?? 'player'} -> ${OUT}`);
const base = parseObj(read(path.join(P.mh, '3dobjs/base.obj')));
for (const [file, weight] of spec.targets) applyTarget(base.v, path.join(P.mh, 'targets', file), weight);
if (spec.scale && spec.scale !== 1) for (const v of base.v) for (let n = 0; n < 3; n++) v[n] *= spec.scale;
const V = base.v;

// ------------------------------------------------------------------------------------------------
// Rig

const groups = JSON.parse(read(path.join(P.mpfb, 'mesh_metadata/basemesh_vertex_groups.json')));
const rig = JSON.parse(read(path.join(P.mpfb, 'rigs/standard/rig.game_engine.json')));
const rigWeights = JSON.parse(read(path.join(P.mpfb, 'rigs/standard/weights.game_engine.json'))).weights;

function mean(indices) {
  const o = [0, 0, 0];
  for (const i of indices) {
    o[0] += V[i][0];
    o[1] += V[i][1];
    o[2] += V[i][2];
  }
  return o.map((x) => x / indices.length);
}
function rangeIndices(ranges) {
  const out = [];
  for (const [a, b] of ranges) for (let i = a; i <= b; i++) out.push(i);
  return out;
}
function jointPos(spec) {
  if (spec.strategy === 'CUBE') return mean(rangeIndices(groups[spec.cube_name]));
  if (spec.strategy === 'VERTEX') return V[spec.vertex_index].slice();
  if (spec.strategy === 'MEAN') return mean(spec.vertex_indices);
  throw new Error(`unknown joint strategy ${spec.strategy}`);
}
const ground = mean(rangeIndices(groups['joint-ground']))[1];

// Parents first.
const boneNames = [];
(function order() {
  const done = new Set();
  const visit = (n) => {
    if (done.has(n)) return;
    const parent = rig[n].parent;
    if (parent) visit(parent);
    done.add(n);
    boneNames.push(n);
  };
  Object.keys(rig).forEach(visit);
})();
const boneIndex = new Map(boneNames.map((n, i) => [n, i]));
const toM = (p) => [p[0] * DM, (p[1] - ground) * DM, p[2] * DM];
const bones = boneNames.map((n) => ({
  name: n,
  parent: rig[n].parent || null,
  head: toM(jointPos(rig[n].head)),
  tail: toM(jointPos(rig[n].tail)),
}));

// Per-vertex weights of the base mesh (helpers included, they drive the clothes).
const vWeights = Array.from({ length: V.length }, () => []);
for (const [bone, list] of Object.entries(rigWeights)) {
  const bi = boneIndex.get(bone);
  if (bi === undefined) continue;
  for (const [vi, w] of list) if (w > 0) vWeights[vi].push([bi, w]);
}
function top4(list) {
  const m = new Map();
  for (const [b, w] of list) m.set(b, (m.get(b) ?? 0) + w);
  const arr = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  const sum = arr.reduce((s, x) => s + x[1], 0) || 1;
  const out = arr.map(([b, w]) => [b, w / sum]);
  while (out.length < 4) out.push([0, 0]);
  return out;
}

// ------------------------------------------------------------------------------------------------
// Proxies (clothes, shoes, hair, eyes): fitted to the morphed body

function parseMhclo(file) {
  const scale = [null, null, null];
  const refs = [];
  const deleteVerts = new Set();
  let objFile = '';
  let mode = '';
  for (const raw of read(file).split('\n')) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const w = line.split(/\s+/);
    if (w[0] === 'x_scale') scale[0] = [+w[1], +w[2], +w[3]];
    else if (w[0] === 'y_scale') scale[1] = [+w[1], +w[2], +w[3]];
    else if (w[0] === 'z_scale') scale[2] = [+w[1], +w[2], +w[3]];
    else if (w[0] === 'obj_file') objFile = w[1];
    else if (w[0] === 'verts') mode = 'verts';
    else if (w[0] === 'delete_verts') mode = 'delete';
    else if (/^[a-z_]/i.test(w[0])) continue; // other keywords may sit between the sections
    else if (mode === 'verts') {
      if (w.length === 1) refs.push({ v: [+w[0], +w[0], +w[0]], w: [1, 0, 0], d: [0, 0, 0] });
      else refs.push({ v: [+w[0], +w[1], +w[2]], w: [+w[3], +w[4], +w[5]], d: [+(w[6] ?? 0), +(w[7] ?? 0), +(w[8] ?? 0)] });
    } else if (mode === 'delete') {
      for (let i = 0; i < w.length; i++) {
        if (w[i + 1] === '-') {
          for (let k = +w[i]; k <= +w[i + 2]; k++) deleteVerts.add(k);
          i += 2;
        } else deleteVerts.add(+w[i]);
      }
    }
  }
  return { scale, refs, deleteVerts, objFile };
}

function fitProxy(dir, name) {
  const clo = parseMhclo(path.join(dir, `${name}.mhclo`));
  const obj = parseObj(read(path.join(dir, clo.objFile)));
  const S = clo.scale.map((s, n) => (s ? Math.abs(V[s[0]][n] - V[s[1]][n]) / s[2] : 1));
  const pos = clo.refs.map((r) => {
    const o = [0, 0, 0];
    for (let k = 0; k < 3; k++) for (let n = 0; n < 3; n++) o[n] += r.w[k] * V[r.v[k]][n];
    for (let n = 0; n < 3; n++) o[n] += r.d[n] * S[n];
    return o;
  });
  const weights = clo.refs.map((r) => {
    const acc = [];
    for (let k = 0; k < 3; k++) for (const [b, w] of vWeights[r.v[k]]) acc.push([b, w * r.w[k]]);
    return acc;
  });
  if (pos.length !== obj.v.length) throw new Error(`${name}: ${pos.length} refs for ${obj.v.length} vertices`);
  console.log(`  ${name}: ${obj.v.length} verts, ${obj.faces.length} faces, scale ${S.map((x) => x.toFixed(3)).join(' ')}`);
  return { pos, weights, vt: obj.vt, faces: obj.faces, deleteVerts: clo.deleteVerts };
}

console.log('fitting proxies');
const suit = fitProxy(path.join(P.assets, 'clothes/male_casualsuit06'), 'male_casualsuit06');
const shoes = fitProxy(path.join(P.assets, 'clothes/shoes05'), 'shoes05');
const hair = spec.hair ? fitProxy(path.join(P.assets, `hair/${spec.hair}`), spec.hair) : null;
const eyes = fitProxy(path.join(P.mh, 'eyes/low-poly'), 'low-poly');

// ------------------------------------------------------------------------------------------------
// Geometry assembly

/** Builds one primitive from faces; vertices are split per (position, uv) pair. */
function buildPrimitive(positions, weightsOf, uvs, faces, opts = {}) {
  // Smooth normals per position index, area weighted.
  const nrm = positions.map(() => [0, 0, 0]);
  for (const f of faces) {
    const a = positions[f.verts[0][0]];
    for (let i = 1; i + 1 < f.verts.length; i++) {
      const b = positions[f.verts[i][0]];
      const c = positions[f.verts[i + 1][0]];
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
      for (const k of [0, i, i + 1]) {
        const t = nrm[f.verts[k][0]];
        t[0] += n[0];
        t[1] += n[1];
        t[2] += n[2];
      }
    }
  }
  const map = new Map();
  const out = { position: [], normal: [], uv: [], joints: [], weights: [], index: [] };
  const vert = (vi, ti) => {
    const key = `${vi}/${ti}`;
    let id = map.get(key);
    if (id !== undefined) return id;
    id = out.position.length / 3;
    map.set(key, id);
    const p = positions[vi];
    out.position.push(p[0] * DM, (p[1] - ground) * DM, p[2] * DM);
    const n = nrm[vi];
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    out.normal.push(n[0] / l, n[1] / l, n[2] / l);
    const t = ti >= 0 ? uvs[ti] : [0, 0];
    out.uv.push(t[0], 1 - t[1]);
    const w = opts.bone !== undefined ? [[opts.bone, 1], [0, 0], [0, 0], [0, 0]] : top4(weightsOf(vi));
    for (const [b, x] of w) {
      out.joints.push(b);
      out.weights.push(x);
    }
    return id;
  };
  for (const f of faces) {
    const ids = f.verts.map(([vi, ti]) => vert(vi, ti));
    for (let i = 1; i + 1 < ids.length; i++) out.index.push(ids[0], ids[i], ids[i + 1]);
  }
  return out;
}

// Shorts: the suit's jeans are cut above the knee and the cut ring is flattened into a hem.
const kneeY = (jointPos(rig.calf_l.head)[1] + jointPos(rig.calf_r.head)[1]) / 2;
const hemY = kneeY + 0.75 * (spec.scale ?? 1); // decimetres: about 7 cm above the knee joint
// In the suit texture the tee occupies the top of the image, the jeans the bottom.
const isJeansFace = (f) => f.verts.reduce((s, [, ti]) => s + (1 - suit.vt[ti][1]), 0) / f.verts.length > 0.43;
const teeFaces = suit.faces.filter((f) => !isJeansFace(f));
const shortsFaces = suit.faces.filter(isJeansFace).filter((f) => f.verts.some(([vi]) => suit.pos[vi][1] > hemY));
const shortsVerts = new Set(shortsFaces.flatMap((f) => f.verts.map(([vi]) => vi)));
for (const vi of shortsVerts) {
  const p = suit.pos[vi];
  if (p[1] < hemY) p[1] = hemY;
  // Loosen the legs of the shorts a little towards the hem so they do not look like tights.
  const crotchY = jointPos(rig.thigh_l.head)[1] - 0.6;
  if (p[1] < crotchY) {
    const k = 1 + 0.07 * Math.min(1, (crotchY - p[1]) / (crotchY - hemY));
    const cx = Math.sign(p[0]) * Math.abs(jointPos(rig.thigh_l.head)[0]);
    p[0] = cx + (p[0] - cx) * k;
    p[2] *= k;
  }
}

// Body: hide what the clothes cover. The lower legs come back since the jeans became shorts.
const hidden = new Set([...shoes.deleteVerts]);
for (const vi of suit.deleteVerts) if (V[vi][1] > hemY + 0.25) hidden.add(vi);
const bodyFaces = base.faces.filter((f) => f.group === 'body' && !f.verts.every(([vi]) => hidden.has(vi)));

const prims = {
  skin: buildPrimitive(V, (vi) => vWeights[vi], base.vt, bodyFaces),
  tee: buildPrimitive(suit.pos, (vi) => suit.weights[vi], suit.vt, teeFaces),
  shorts: buildPrimitive(suit.pos, (vi) => suit.weights[vi], suit.vt, shortsFaces),
  shoes: buildPrimitive(shoes.pos, (vi) => shoes.weights[vi], shoes.vt, shoes.faces),
  ...(hair ? { hair: buildPrimitive(hair.pos, (vi) => hair.weights[vi], hair.vt, hair.faces, { bone: boneIndex.get('head') }) } : {}),
  eyes: buildPrimitive(eyes.pos, (vi) => eyes.weights[vi], eyes.vt, eyes.faces, { bone: boneIndex.get('head') }),
};
for (const [k, p] of Object.entries(prims)) console.log(`  ${k}: ${p.position.length / 3} verts, ${p.index.length / 3} tris`);

// ------------------------------------------------------------------------------------------------
// Textures

/**
 * Suit texture: the tee keeps only its shading (the printed logo is blurred away and the
 * ambient-occlusion map supplies the folds), the jeans become a neutral grey cloth so the game
 * can tint tee and shorts in team colours.
 */
async function suitTexture(dir, size) {
  const diffuse = path.join(dir, 'male_casualsuit06_diffuse.png');
  const ao = await sharp(path.join(dir, 'male_casualsuit06_ao.png')).resize(size, size).removeAlpha().raw().toBuffer();
  const blurred = await sharp(diffuse).resize(size, size).removeAlpha().blur(size / 40).raw().toBuffer();
  const sharpD = await sharp(diffuse).resize(size, size).removeAlpha().raw().toBuffer();
  const out = Buffer.alloc(size * size * 3);
  const split = Math.floor(size * 0.43);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 3;
      const occ = ao[i] / 255;
      if (y < split) {
        const lum = (blurred[i] + blurred[i + 1] + blurred[i + 2]) / 3;
        const v = Math.min(255, (0.55 * 255 + 0.45 * lum) * (0.45 + 0.55 * occ) * 1.12);
        out[i] = out[i + 1] = out[i + 2] = v;
      } else {
        // Denim luminance, flattened and lifted so that a dark tint still shows the weave.
        const lum = (sharpD[i] * 0.3 + sharpD[i + 1] * 0.5 + sharpD[i + 2] * 0.2) / 255;
        const v = Math.min(255, (0.62 + 0.38 * lum) * (0.5 + 0.5 * occ) * 255);
        out[i] = out[i + 1] = out[i + 2] = v;
      }
    }
  }
  return sharp(out, { raw: { width: size, height: size, channels: 3 } }).webp({ quality: 82, effort: 6 }).toBuffer();
}

// ------------------------------------------------------------------------------------------------
// glTF

const doc = new Document();
doc.createExtension(EXTTextureWebP).setRequired(true);
const buffer = doc.createBuffer();
const scene = doc.createScene('Player');

const boneNodes = bones.map((b) => doc.createNode(b.name));
bones.forEach((b, i) => {
  const parent = b.parent ? bones[boneIndex.get(b.parent)] : null;
  boneNodes[i].setTranslation(parent ? [b.head[0] - parent.head[0], b.head[1] - parent.head[1], b.head[2] - parent.head[2]] : b.head);
  // The tail is kept so the game knows each bone's rest direction and length.
  boneNodes[i].setExtras({ tail: b.tail });
  if (parent) boneNodes[boneIndex.get(b.parent)].addChild(boneNodes[i]);
});
const ibm = new Float32Array(bones.length * 16);
bones.forEach((b, i) => ibm.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -b.head[0], -b.head[1], -b.head[2], 1], i * 16));
const skin = doc.createSkin('PlayerSkin');
skin.setInverseBindMatrices(doc.createAccessor('ibm').setType('MAT4').setArray(ibm).setBuffer(buffer));
boneNodes.forEach((n) => skin.addJoint(n));
const rootBone = boneNodes[bones.findIndex((b) => !b.parent)];
skin.setSkeleton(rootBone);

async function texture(name, bytes) {
  return doc.createTexture(name).setImage(bytes).setMimeType('image/webp');
}
const texDir = P.tex;
console.log('encoding textures');
const lean = !!spec.lean;
const texSkin = await texture('skin', await webp(path.join(texDir, `skins/textures/${spec.skin}.png`), 1024, 80));
const texSuit = lean ? null : await texture('suit', await suitTexture(path.join(texDir, 'clothes/male_casualsuit06'), 1024));
const texSuitN = lean ? null : await texture('suit_normal', await webp(path.join(texDir, 'clothes/male_casualsuit06/male_casualsuit06_normal.png'), 512, 85));
const texShoes = lean ? null : await texture('shoes', await webp(path.join(texDir, 'clothes/shoes05/shoes05_diffuse.png'), 512, 80));
const hairPng = spec.hair ? path.join(texDir, `hair/${spec.hair}/${spec.hair}_diffuse.png`) : null;
const texHair = !hairPng ? null : await texture('hair', lean ? await greyHair(hairPng, 512) : await webp(hairPng, 512, 82, true));
const texEyes = lean ? null : await texture('eyes', await webp(path.join(P.mh, 'eyes/materials/brown_eye.png'), 256, 82, true));

const mat = (name, tex, o = {}) => {
  const m = doc
    .createMaterial(name)
    .setRoughnessFactor(o.roughness ?? 0.8)
    .setMetallicFactor(0)
    .setDoubleSided(!!o.doubleSided);
  if (tex) m.setBaseColorTexture(tex);
  if (o.normal) m.setNormalTexture(o.normal);
  if (o.alpha) m.setAlphaMode(o.alpha).setAlphaCutoff(0.35);
  return m;
};
const materials = {
  skin: mat('skin', texSkin, { roughness: 0.62 }),
  tee: mat('tee', texSuit, { roughness: 0.88, normal: texSuitN ?? undefined, doubleSided: true }),
  shorts: mat('shorts', texSuit, { roughness: 0.85, normal: texSuitN ?? undefined, doubleSided: true }),
  shoes: mat('shoes', texShoes, { roughness: 0.6 }),
  ...(texHair ? { hair: mat('hair', texHair, { roughness: 0.75, alpha: 'MASK', doubleSided: true }) } : {}),
  eyes: mat('eyes', texEyes, { roughness: 0.2, alpha: 'MASK' }),
};

const mesh = doc.createMesh('PlayerMesh');
for (const [name, p] of Object.entries(prims)) {
  const count = p.position.length / 3;
  const prim = doc
    .createPrimitive()
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(p.position)).setBuffer(buffer))
    .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(new Float32Array(p.normal)).setBuffer(buffer))
    .setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(new Float32Array(p.uv)).setBuffer(buffer))
    .setAttribute('JOINTS_0', doc.createAccessor().setType('VEC4').setArray(new Uint8Array(p.joints)).setBuffer(buffer))
    .setAttribute('WEIGHTS_0', doc.createAccessor().setType('VEC4').setArray(new Float32Array(p.weights)).setBuffer(buffer))
    .setIndices(doc.createAccessor().setType('SCALAR').setArray(count > 65535 ? new Uint32Array(p.index) : new Uint16Array(p.index)).setBuffer(buffer))
    .setMaterial(materials[name]);
  prim.setExtras({ part: name });
  mesh.addPrimitive(prim);
}
const meshNode = doc.createNode('Player').setMesh(mesh).setSkin(skin);
scene.addChild(meshNode);
scene.addChild(rootBone);

doc.createExtension(KHRDracoMeshCompression).setRequired(true);
await doc.transform(dedup(), prune({ keepAttributes: true }), draco({ method: 'edgebreaker', quantizePosition: 13, quantizeNormal: 8, quantizeTexcoord: 11 }));

const io = new NodeIO().registerExtensions([KHRDracoMeshCompression, EXTTextureWebP]).registerDependencies({
  'draco3d.encoder': await draco3d.createEncoderModule(),
  'draco3d.decoder': await draco3d.createDecoderModule(),
});
fs.mkdirSync(path.dirname(OUT), { recursive: true });
await io.write(OUT, doc);
console.log(`wrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);

}

/** Hair texture as a light neutral grey with its alpha kept, so the game can tint it any colour. */
async function greyHair(file, size) {
  const { data, info } = await sharp(file).resize(size, size, { fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let sum = 0;
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 90) continue;
    sum += data[i] * 0.3 + data[i + 1] * 0.59 + data[i + 2] * 0.11;
    n++;
  }
  const mean = n ? sum / n : 128;
  for (let i = 0; i < data.length; i += 4) {
    const lum = data[i] * 0.3 + data[i + 1] * 0.59 + data[i + 2] * 0.11;
    // Keep the strand detail, centred on a light grey.
    const v = Math.max(0, Math.min(255, 170 + (lum - mean) * 1.1));
    data[i] = data[i + 1] = data[i + 2] = v;
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).webp({ quality: 82, alphaQuality: 90, effort: 6 }).toBuffer();
}

// ------------------------------------------------------------------------------------------------
// The roster

const M = 'macrodetails/';
/** Body: ethnic face and frame, then muscle and weight (weights of each group add up to 1). */
const body = (race, gender, age, muscle = 0, weight = 0) => {
  const out = [];
  const ages = Array.isArray(age) ? age : [[age, 1]];
  for (const [a, w] of ages) {
    out.push([`${M}${race}-${gender}-${a}.target`, w]);
    const m = Math.abs(muscle);
    const k = Math.abs(weight);
    const mName = muscle >= 0 ? 'maxmuscle' : 'minmuscle';
    const wName = weight >= 0 ? 'maxweight' : 'minweight';
    const u = (mm, ww, x) => x > 0.001 && out.push([`${M}universal-${gender}-${a}-${mm}-${ww}.target`, w * x]);
    u('averagemuscle', 'averageweight', (1 - m) * (1 - k));
    u(mName, 'averageweight', m * (1 - k));
    u('averagemuscle', wName, (1 - m) * k);
    u(mName, wName, m * k);
  }
  return out;
};

/** Ten players, all invented: build, face, skin and hair differ; the outfit is tinted by the game. */
export const ROSTER = [
  { id: 'leo', targets: [...body('caucasian', 'male', 'young', 0.35)], scale: 1, hair: 'short02', skin: 'young_lightskinned_male_diffuse' },
  { id: 'malik', targets: [...body('african', 'male', 'young', 0.7), ['head/head-square.target', 0.4]], scale: 1.05, hair: 'short04', skin: 'young_darkskinned_male_diffuse' },
  { id: 'ines', targets: [...body('caucasian', 'female', 'young', 0.3, -0.2), ['head/head-oval.target', 0.4]], scale: 0.97, hair: 'ponytail01', skin: 'young_lightskinned_female_diffuse' },
  { id: 'kenji', targets: [...body('asian', 'male', 'young', 0.2, -0.35)], scale: 0.96, hair: 'short03', skin: 'young_lightskinned_male_diffuse2' },
  { id: 'aicha', targets: [...body('african', 'female', 'young', 0.6), ['head/head-diamond.target', 0.3]], scale: 1.0, hair: 'braid01', skin: 'young_darkskinned_female_diffuse' },
  { id: 'hugo', targets: [...body('caucasian', 'male', [['old', 0.55], ['young', 0.45]], 0.1, 0.25), ['head/head-rectangular.target', 0.4]], scale: 0.99, hair: 'short01', skin: 'old_lightskinned_male_diffuse' },
  { id: 'mei', targets: [...body('asian', 'female', 'young', 0.1, -0.3), ['head/head-round.target', 0.4]], scale: 0.93, hair: 'bob01', skin: 'young_lightskinned_female_diffuse2' },
  { id: 'bruno', targets: [...body('caucasian', 'male', [['young', 0.7], ['old', 0.3]], 0.7, 0.55), ['head/head-round.target', 0.5]], scale: 0.98, hair: null, skin: 'middleage_lightskinned_male_diffuse' },
  { id: 'sofia', targets: [...body('caucasian', 'female', 'young', 0.45, -0.1), ['head/head-invertedtriangular.target', 0.4]], scale: 1.03, hair: 'bob02', skin: 'young_lightskinned_female_diffuse3' },
  { id: 'diego', targets: [...body('caucasian', 'male', 'young', 0.15, -0.3), ['head/head-triangular.target', 0.4]], scale: 1.01, hair: 'long01', skin: 'middleage_lightskinned_male_diffuse2' },
];

if (process.argv[3] === '--roster') {
  // One lean file per character, next to the base model.
  const dir = process.argv[4] ?? 'public/models/chars';
  const only = process.argv[5];
  for (const spec of ROSTER) if (!only || only === spec.id) await build({ ...spec, lean: true }, path.join(dir, `${spec.id}.glb`));
} else {
  const OUT = process.argv[3] ?? 'public/models/player.glb';
  await build({ ...ROSTER[0], lean: false }, OUT);
  // Second skin tone, loaded on demand by the game.
  const extra = path.join(path.dirname(OUT), 'skin_dark.webp');
  fs.writeFileSync(extra, await webp(path.join(P.tex, 'skins/textures/young_darkskinned_male_diffuse.png'), 1024, 80));
  console.log(`wrote ${extra} (${(fs.statSync(extra).size / 1024).toFixed(0)} KB)`);
}
