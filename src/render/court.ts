import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { netHeightAt, sideWallAt } from '../physics/ballistics';
import { COURT } from '../rules/court';
import {
  createBlobTexture,
  createBoardTexture,
  createCrowdTexture,
  createFenceTexture,
  createNetTexture,
  createTurfTextures,
} from './textures';

const W = COURT.halfWidth;
const L = COURT.halfLength;

export interface CourtBuild {
  group: THREE.Group;
  /** Playing surface: its colour can be changed (shop items). */
  turfMaterial: THREE.MeshStandardMaterial;
  glassMaterial: THREE.MeshStandardMaterial;
  /** Wire mesh of the wall the camera looks through, faded so it does not veil the court. */
  nearFenceMaterial: THREE.MeshStandardMaterial;
  /** Positions of the floodlight heads, for placing lights. */
  floodlights: THREE.Vector3[];
}

function box(w: number, h: number, d: number, x: number, y: number, z: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}

/** Vertical or horizontal rectangle with UVs in metres divided by `tile`. */
function quad(
  a: THREE.Vector3,
  b: THREE.Vector3,
  c: THREE.Vector3,
  d: THREE.Vector3,
  uSize: number,
  vSize: number,
  tile: number,
): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(d, a)).normalize();
  g.setAttribute('position', new THREE.Float32BufferAttribute([a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, d.x, d.y, d.z], 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute([n.x, n.y, n.z, n.x, n.y, n.z, n.x, n.y, n.z, n.x, n.y, n.z], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, uSize / tile, 0, uSize / tile, vSize / tile, 0, vSize / tile], 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

/** Wall panel on a constant-z plane (back walls). */
function panelZ(z: number, x0: number, x1: number, y0: number, y1: number, tile: number): THREE.BufferGeometry {
  const v = (x: number, y: number) => new THREE.Vector3(x, y, z);
  return quad(v(x0, y0), v(x1, y0), v(x1, y1), v(x0, y1), x1 - x0, y1 - y0, tile);
}

/** Wall panel on a constant-x plane (side walls). */
function panelX(x: number, z0: number, z1: number, y0: number, y1: number, tile: number): THREE.BufferGeometry {
  const v = (z: number, y: number) => new THREE.Vector3(x, y, z);
  return quad(v(z0, y0), v(z1, y0), v(z1, y1), v(z0, y1), z1 - z0, y1 - y0, tile);
}

/**
 * Glass that stays almost invisible face-on and turns reflective at grazing angles, with
 * highlights from the floodlights kept bright. Real refraction is skipped: on phones it would
 * need an extra full-scene pass.
 */
function createGlassMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: 0xbfded6,
    roughness: 0.04,
    metalness: 0,
    transparent: true,
    opacity: 0.07,
    side: THREE.DoubleSide,
    depthWrite: false,
    envMapIntensity: 1.35,
  });
  m.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <opaque_fragment>',
      `#include <opaque_fragment>
      {
        float ndv = abs( dot( normalize( vViewPosition ), normal ) );
        float fres = pow( 1.0 - ndv, 4.0 );
        float specLum = dot( totalSpecular, vec3( 0.333 ) );
        gl_FragColor.a = clamp( gl_FragColor.a + fres * 0.55 + specLum * 1.5, 0.0, 1.0 );
      }`,
    );
  };
  return m;
}

export function buildCourt(aniso: number): CourtBuild {
  const group = new THREE.Group();
  group.name = 'court';

  // --- Playing surface -----------------------------------------------------------------------
  const turf = createTurfTextures(aniso);
  const TURF_TILE = 1.6; // metres covered by one texture tile
  const turfMat = new THREE.MeshStandardMaterial({
    color: 0x1e63c8,
    map: turf.map,
    normalMap: turf.normalMap,
    normalScale: new THREE.Vector2(0.55, 0.55),
    roughnessMap: turf.roughnessMap,
    roughness: 1,
    metalness: 0,
  });
  const floorGeo = new THREE.PlaneGeometry(2 * W, 2 * L);
  floorGeo.rotateX(-Math.PI / 2);
  const uv = floorGeo.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) * 2 * W) / TURF_TILE, (uv.getY(i) * 2 * L) / TURF_TILE);
  const floor = new THREE.Mesh(floorGeo, turfMat);
  floor.receiveShadow = true;
  group.add(floor);

  // --- Lines: the two service lines and the centre line (no baselines or sidelines in padel) --
  const lineMat = new THREE.MeshStandardMaterial({
    color: 0xf2f4f5,
    map: turf.map,
    normalMap: turf.normalMap,
    normalScale: new THREE.Vector2(0.4, 0.4),
    roughness: 0.9,
    metalness: 0,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const lw = COURT.lineWidth;
  const lineGeos: THREE.BufferGeometry[] = [];
  const addLine = (x0: number, x1: number, z0: number, z1: number) => {
    const y = 0.003;
    const v = (x: number, z: number) => new THREE.Vector3(x, y, z);
    lineGeos.push(quad(v(x0, z1), v(x1, z1), v(x1, z0), v(x0, z0), x1 - x0, z1 - z0, TURF_TILE));
  };
  addLine(-W, W, COURT.serviceLineZ - lw / 2, COURT.serviceLineZ + lw / 2);
  addLine(-W, W, -COURT.serviceLineZ - lw / 2, -COURT.serviceLineZ + lw / 2);
  // The centre line runs 20 cm past each service line.
  addLine(-lw / 2, lw / 2, -COURT.serviceLineZ - 0.2, COURT.serviceLineZ + 0.2);
  const lines = new THREE.Mesh(mergeGeometries(lineGeos), lineMat);
  lines.receiveShadow = true;
  group.add(lines);

  // --- Surroundings ---------------------------------------------------------------------------
  const apronMat = new THREE.MeshStandardMaterial({
    color: 0x16233a,
    map: turf.map,
    normalMap: turf.normalMap,
    normalScale: new THREE.Vector2(0.3, 0.3),
    roughness: 0.95,
  });
  const apronGeo = new THREE.PlaneGeometry(70, 90);
  apronGeo.rotateX(-Math.PI / 2);
  const auv = apronGeo.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < auv.count; i++) auv.setXY(i, auv.getX(i) * 30, auv.getY(i) * 38);
  const apron = new THREE.Mesh(apronGeo, apronMat);
  apron.position.y = -0.03;
  apron.receiveShadow = true;
  group.add(apron);

  // --- Steel structure -----------------------------------------------------------------------
  const steelMat = new THREE.MeshStandardMaterial({ color: 0x15181c, roughness: 0.45, metalness: 0.85 });
  const steel: THREE.BufferGeometry[] = [];
  /** Structure of the back wall on the camera side, drawn faintly so it does not hide the play. */
  const nearSteel: THREE.BufferGeometry[] = [];
  const P = 0.07; // post section
  const off = P / 2 + 0.012; // posts stand just outside the glass line
  for (const s of [-1, 1]) {
    // Back wall posts every 2 m, top and mid rails.
    const backSteel = s > 0 ? nearSteel : steel;
    for (let x = -W + 2; x <= W - 2 + 1e-6; x += 2)
      backSteel.push(box(P, COURT.backTotalHeight, P, x, COURT.backTotalHeight / 2, s * (L + off)));
    backSteel.push(box(2 * W + P, 0.05, 0.05, 0, COURT.backTotalHeight, s * (L + off)));
    backSteel.push(box(2 * W + P, 0.04, 0.04, 0, COURT.backGlassHeight, s * (L + off)));
    // Side walls.
    for (const e of [-1, 1]) {
      const zs = [L - 2, L - 4, L - 6, L - 8];
      for (const d of zs) {
        const z = e * d;
        const h = d >= L - 2 ? COURT.sideStep1TotalHeight : COURT.sideFenceHeight;
        steel.push(box(P, h, P, s * (W + off), h / 2, z));
      }
      // Stepped top rails and the rails where glass meets mesh.
      const zc1 = e * (L - 1);
      const zc2 = e * (L - 3);
      steel.push(box(0.05, 0.05, 2, s * (W + off), COURT.sideStep1TotalHeight, zc1));
      steel.push(box(0.04, 0.04, 2, s * (W + off), COURT.sideStep1GlassHeight, zc1));
      steel.push(box(0.05, 0.05, 2, s * (W + off), COURT.sideStep2TotalHeight, zc2));
      steel.push(box(0.04, 0.04, 2, s * (W + off), COURT.sideStep2GlassHeight, zc2));
    }
    steel.push(box(P, COURT.sideFenceHeight, P, s * (W + off), COURT.sideFenceHeight / 2, 0));
    steel.push(box(0.05, 0.05, 12, s * (W + off), COURT.sideFenceHeight, 0));
    steel.push(box(0.04, 0.04, 12, s * (W + off), 0.03, 0));
    // Corner posts.
    for (const e of [-1, 1]) {
      steel.push(box(P, COURT.backTotalHeight, P, s * (W + off), COURT.backTotalHeight / 2, e * (L + off)));
    }
  }
  const structure = new THREE.Mesh(mergeGeometries(steel), steelMat);
  structure.castShadow = true;
  structure.receiveShadow = true;
  group.add(structure);
  const nearSteelMat = new THREE.MeshStandardMaterial({
    color: 0x15181c,
    roughness: 0.45,
    metalness: 0.85,
    transparent: true,
    opacity: 0.16,
    depthWrite: false,
  });
  const nearStructure = new THREE.Mesh(mergeGeometries(nearSteel), nearSteelMat);
  nearStructure.renderOrder = 6;
  group.add(nearStructure);

  // --- Glass ---------------------------------------------------------------------------------
  const glassMaterial = createGlassMaterial();
  const glass: THREE.BufferGeometry[] = [];
  const edges: THREE.BufferGeometry[] = [];
  const GAP = 0.006;
  for (const s of [-1, 1]) {
    for (let x = -W; x < W - 1e-6; x += 2) {
      glass.push(panelZ(s * L, x + GAP, x + 2 - GAP, 0.02, COURT.backGlassHeight, 1));
      if (x > -W) edges.push(box(0.012, COURT.backGlassHeight - 0.02, 0.012, x, COURT.backGlassHeight / 2, s * L));
    }
    for (const e of [-1, 1]) {
      const z0 = e * L;
      const z1 = e * (L - 2);
      const z2 = e * (L - 4);
      glass.push(panelX(s * W, Math.min(z0, z1) + GAP, Math.max(z0, z1) - GAP, 0.02, COURT.sideStep1GlassHeight, 1));
      glass.push(panelX(s * W, Math.min(z1, z2) + GAP, Math.max(z1, z2) - GAP, 0.02, COURT.sideStep2GlassHeight, 1));
    }
  }
  const glassMesh = new THREE.Mesh(mergeGeometries(glass), glassMaterial);
  glassMesh.renderOrder = 2;
  group.add(glassMesh);
  // Polished glass edges catch the light with the familiar green tint.
  const edgeMat = new THREE.MeshStandardMaterial({ color: 0x4f8f7c, roughness: 0.2, metalness: 0, transparent: true, opacity: 0.55 });
  const edgeMesh = new THREE.Mesh(mergeGeometries(edges), edgeMat);
  edgeMesh.renderOrder = 2;
  group.add(edgeMesh);

  // --- Wire mesh -----------------------------------------------------------------------------
  const FENCE_TILE = 0.2; // four 50 mm squares per tile
  const fenceTex = createFenceTexture(aniso);
  const makeFenceMat = (opacity: number) =>
    new THREE.MeshStandardMaterial({
      map: fenceTex,
      transparent: true,
      opacity,
      side: THREE.DoubleSide,
      depthWrite: false,
      roughness: 0.5,
      metalness: 0.7,
      alphaTest: 0.02,
    });
  const fenceMaterial = makeFenceMat(1);
  const nearFenceMaterial = makeFenceMat(0.18);
  const fence: THREE.BufferGeometry[] = [];
  const nearFence: THREE.BufferGeometry[] = [];
  for (const s of [-1, 1]) {
    const back = panelZ(s * L, -W, W, COURT.backGlassHeight, COURT.backTotalHeight, FENCE_TILE);
    (s > 0 ? nearFence : fence).push(back);
    for (const e of [-1, 1]) {
      const z0 = e * L;
      const z1 = e * (L - 2);
      const z2 = e * (L - 4);
      fence.push(panelX(s * W, Math.min(z0, z1), Math.max(z0, z1), COURT.sideStep1GlassHeight, COURT.sideStep1TotalHeight, FENCE_TILE));
      fence.push(panelX(s * W, Math.min(z1, z2), Math.max(z1, z2), COURT.sideStep2GlassHeight, COURT.sideStep2TotalHeight, FENCE_TILE));
    }
    const c = L - 4;
    fence.push(panelX(s * W, -c, c, 0, sideWallAt(0).total, FENCE_TILE));
  }
  const fenceMesh = new THREE.Mesh(mergeGeometries(fence), fenceMaterial);
  fenceMesh.renderOrder = 3;
  group.add(fenceMesh);
  const nearFenceMesh = new THREE.Mesh(mergeGeometries(nearFence), nearFenceMaterial);
  nearFenceMesh.renderOrder = 4;
  group.add(nearFenceMesh);

  // --- Net -----------------------------------------------------------------------------------
  const NET_TILE = 0.18;
  const TAPE = 0.05;
  const segs = 20;
  const netPos: number[] = [];
  const netUv: number[] = [];
  const netIdx: number[] = [];
  const tapePos: number[] = [];
  const tapeIdx: number[] = [];
  for (let i = 0; i <= segs; i++) {
    const x = -W + (2 * W * i) / segs;
    const top = netHeightAt(x);
    netPos.push(x, 0.03, 0, x, top - TAPE, 0);
    netUv.push(x / NET_TILE, 0, x / NET_TILE, (top - TAPE) / NET_TILE);
    tapePos.push(x, top - TAPE, 0, x, top, 0);
    if (i < segs) {
      const a = i * 2;
      netIdx.push(a, a + 2, a + 3, a, a + 3, a + 1);
      tapeIdx.push(a, a + 2, a + 3, a, a + 3, a + 1);
    }
  }
  const netGeo = new THREE.BufferGeometry();
  netGeo.setAttribute('position', new THREE.Float32BufferAttribute(netPos, 3));
  netGeo.setAttribute('uv', new THREE.Float32BufferAttribute(netUv, 2));
  netGeo.setIndex(netIdx);
  netGeo.computeVertexNormals();
  const netMat = new THREE.MeshStandardMaterial({
    map: createNetTexture(aniso),
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
    roughness: 0.9,
    alphaTest: 0.02,
  });
  const net = new THREE.Mesh(netGeo, netMat);
  net.renderOrder = 1;
  group.add(net);

  const tapeGeo = new THREE.BufferGeometry();
  tapeGeo.setAttribute('position', new THREE.Float32BufferAttribute(tapePos, 3));
  tapeGeo.setIndex(tapeIdx);
  tapeGeo.computeVertexNormals();
  const tapeMat = new THREE.MeshStandardMaterial({ color: 0xf4f4f2, roughness: 0.8, side: THREE.DoubleSide });
  const tape = new THREE.Mesh(tapeGeo, tapeMat);
  tape.castShadow = true;
  group.add(tape);
  // Centre strap and the posts.
  const strap = new THREE.Mesh(new THREE.PlaneGeometry(0.05, COURT.netHeightCenter - 0.02), tapeMat);
  strap.position.set(0, (COURT.netHeightCenter - 0.02) / 2 + 0.02, 0.004);
  group.add(strap);
  const postGeo = new THREE.CylinderGeometry(0.04, 0.04, COURT.netHeightPost + 0.03, 16);
  for (const s of [-1, 1]) {
    const post = new THREE.Mesh(postGeo, steelMat);
    post.position.set(s * (W - 0.04), (COURT.netHeightPost + 0.03) / 2, 0);
    post.castShadow = true;
    group.add(post);
  }
  // The net itself casts a soft band of shadow: approximate it with a low opaque proxy.
  const netShadow = new THREE.Mesh(
    new THREE.PlaneGeometry(2 * W, 0.04),
    new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }),
  );
  netShadow.position.set(0, COURT.netHeightCenter - 0.02, 0);
  netShadow.castShadow = true;
  group.add(netShadow);

  // --- Floodlights ---------------------------------------------------------------------------
  const floodlights: THREE.Vector3[] = [];
  const lampMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 6.2, 6.6), toneMapped: false });
  const glowTex = createBlobTexture(0.05, 2.4);
  const mastGeos: THREE.BufferGeometry[] = [];
  const lampGeos: THREE.BufferGeometry[] = [];
  const MAST_H = 11;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const px = sx * 9.2;
      const pz = sz * 13.5;
      mastGeos.push(box(0.22, MAST_H, 0.22, px, MAST_H / 2, pz));
      // Lamp head: a tilted frame carrying a grid of LED modules aimed at the court.
      const head = new THREE.Object3D();
      head.position.set(px, MAST_H + 0.3, pz);
      head.lookAt(0, 0, 0);
      head.updateMatrix();
      const frame = new THREE.BoxGeometry(2.2, 1.3, 0.12);
      frame.applyMatrix4(head.matrix);
      mastGeos.push(frame);
      for (let i = 0; i < 4; i++)
        for (let j = 0; j < 2; j++) {
          const led = new THREE.PlaneGeometry(0.44, 0.5);
          led.translate(-0.78 + i * 0.52, -0.3 + j * 0.6, 0.07);
          led.applyMatrix4(head.matrix);
          lampGeos.push(led);
        }
      floodlights.push(head.position.clone());
      const glow = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: glowTex,
          color: 0xdfe8ff,
          transparent: true,
          opacity: 0.55,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          fog: false,
        }),
      );
      glow.position.copy(head.position);
      glow.scale.setScalar(7);
      group.add(glow);
    }
  }
  group.add(new THREE.Mesh(mergeGeometries(mastGeos), steelMat));
  group.add(new THREE.Mesh(mergeGeometries(lampGeos), lampMat));

  // --- Stands, crowd and perimeter boards ------------------------------------------------------
  const crowdTex = createCrowdTexture();
  const crowdMat = new THREE.MeshBasicMaterial({ map: crowdTex, vertexColors: true });
  const standGeos: THREE.BufferGeometry[] = [];
  const addStand = (cx: number, cz: number, width: number, rotY: number) => {
    const depth = 9;
    const rise = 5.5;
    const g = new THREE.PlaneGeometry(width, Math.hypot(depth, rise), 1, 1);
    const u = g.attributes.uv as THREE.BufferAttribute;
    const tint: number[] = [];
    for (let i = 0; i < u.count; i++) {
      // Front rows catch the spill of the floodlights; the back rows sink into darkness.
      const k = u.getY(i) > 0.5 ? 0.1 : 0.62;
      tint.push(k, k, k * 1.08);
      u.setXY(i, (u.getX(i) * width) / 12, u.getY(i) * 1.6);
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(tint, 3));
    g.rotateX(-Math.atan2(depth, rise));
    g.translate(0, rise / 2 + 1.1, -depth / 2);
    g.rotateY(rotY);
    g.translate(cx, 0, cz);
    standGeos.push(g);
  };
  addStand(0, -15.5, 30, 0);
  addStand(0, 15.5, 30, Math.PI);
  addStand(-10.5, 0, 31, Math.PI / 2);
  addStand(10.5, 0, 31, -Math.PI / 2);
  const stands = new THREE.Mesh(mergeGeometries(standGeos), crowdMat);
  group.add(stands);

  const wallMat = new THREE.MeshStandardMaterial({ color: 0x0c1018, roughness: 0.9 });
  const standWalls: THREE.BufferGeometry[] = [
    box(31, 1.1, 0.3, 0, 0.55, -15.5),
    box(31, 1.1, 0.3, 0, 0.55, 15.5),
    box(0.3, 1.1, 31, -10.5, 0.55, 0),
    box(0.3, 1.1, 31, 10.5, 0.55, 0),
  ];
  group.add(new THREE.Mesh(mergeGeometries(standWalls), wallMat));

  const boardTex = createBoardTexture('PADEL 3D', '#0b2f7a', '#ffffff');
  const boardMat = new THREE.MeshBasicMaterial({ map: boardTex, color: new THREE.Color(0.75, 0.75, 0.75) });
  const boards: THREE.BufferGeometry[] = [];
  const addBoard = (cx: number, cz: number, width: number, rotY: number) => {
    const g = new THREE.PlaneGeometry(width, 0.9);
    const u = g.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < u.count; i++) u.setX(i, (u.getX(i) * width) / 14.5);
    g.translate(0, 0.52, 0.16);
    g.rotateY(rotY);
    g.translate(cx, 0, cz);
    boards.push(g);
  };
  addBoard(0, -15.5, 29, 0);
  addBoard(0, 15.5, 29, Math.PI);
  addBoard(-10.5, 0, 29, Math.PI / 2);
  addBoard(10.5, 0, 29, -Math.PI / 2);
  group.add(new THREE.Mesh(mergeGeometries(boards), boardMat));

  return { group, turfMaterial: turfMat, glassMaterial, nearFenceMaterial, floodlights };
}

/** Night sky dome: deep blue overhead, lighter haze towards the horizon from the stadium lights. */
export function buildSky(): THREE.Mesh {
  const geo = new THREE.SphereGeometry(120, 24, 12);
  const colors: number[] = [];
  const top = new THREE.Color(0x03060d);
  const horizon = new THREE.Color(0x16233d);
  const c = new THREE.Color();
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const t = Math.pow(Math.max(0, pos.getY(i) / 120), 0.45);
    c.copy(horizon).lerp(top, t);
    colors.push(c.r, c.g, c.b);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
  mesh.renderOrder = -10;
  return mesh;
}
