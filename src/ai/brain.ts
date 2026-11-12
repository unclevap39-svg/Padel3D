import type { Simulation } from '../core/sim';
import { SWING_LEAD } from '../core/sim';
import type { ShotIntent, ShotType } from '../core/types';
import type { Player } from '../entities/player';
import { COURT, inServiceBox, otherTeam, serviceBoxXSign, type Team } from '../rules/court';
import type { Intercept } from './intercept';

interface Candidate {
  x: number;
  /** Landing distance beyond the net. */
  d: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Decision making for the three (or four) computer players: where to stand, when to swing and
 * which shot to play. Movement mirrors real doubles: the pair holds the net while the opponents
 * play from the back, drops back to defend when they attack, and the player without the ball
 * covers their half.
 */
export class Ai {
  private sim: Simulation;

  constructor(sim: Simulation) {
    this.sim = sim;
  }

  /** Called after every strike: should the receiving pair leave a ball that is going out? */
  onShot(hitTeam: Team): void {
    const sim = this.sim;
    const ref = sim.match.referee;
    const pred = sim.prediction;
    sim.leaveBall = false;
    if (!pred || ref.floorBounces !== 0) return;
    const receiving = otherTeam(hitTeam);
    let goingOut = pred.net || pred.wallBeforeBounce || (pred.out && !pred.firstBounce);
    const fb = pred.firstBounce;
    if (fb) {
      const onReceiverSide = (fb.z > 0 ? 0 : 1) === receiving;
      if (!onReceiverSide) goingOut = true;
      if (ref.isServeInFlight && !inServiceBox(fb.x, fb.z, receiving, serviceBoxXSign(ref.servingTeam, ref.serveSide))) {
        goingOut = true;
      }
    }
    if (!goingOut) return;
    const judge = sim.teamPlayers(receiving).find((p) => !p.isHuman);
    if (!judge) return;
    const lvl = sim.levelOf(judge);
    sim.leaveBall = sim.random() < 0.5 + 0.5 * lvl.placement;
  }

  serveIntent(p: Player): ShotIntent {
    const sim = this.sim;
    const lvl = sim.levelOf(p);
    const ref = sim.match.referee;
    const box = serviceBoxXSign(p.team, ref.serveSide);
    const r = sim.random;
    // Better servers go for the side glass or the T; second serves are safer.
    const second = ref.serveNumber === 2;
    let bx = 1.0 + r() * 3.0;
    if (r() < lvl.placement) bx = r() < 0.6 ? 3.6 + r() * 0.6 : 0.7 + r() * 0.5;
    let d = 4.6 + r() * 1.7;
    if (second) {
      bx = clamp(bx, 1.2, 3.6);
      d = 4.2 + r() * 1.3;
    }
    const err = lvl.aimError * (second ? 0.3 : 0.5);
    bx += sim.gauss() * err;
    d += sim.gauss() * err;
    return {
      type: 'drive',
      power: (second ? 0.25 : 0.35) + 0.5 * lvl.power,
      target: { x: box * bx, z: p.dir * d },
    };
  }

  update(): void {
    const sim = this.sim;
    const ref = sim.match.referee;
    if (ref.phase !== 'rally' && ref.phase !== 'serve_flight') return;
    const receiving = otherTeam(ref.lastHitTeam);
    const hitter = sim.hitterId !== null ? sim.players[sim.hitterId] : null;
    const hitterPlan = hitter ? sim.plans[hitter.id] : null;

    for (const p of sim.players) {
      if (p.isHuman) continue;
      const lvl = sim.levelOf(p);
      // Reaction time: keep doing what we were doing for a moment after the opponents strike.
      const lastBy = sim.lastHitBy !== null ? sim.players[sim.lastHitBy] : null;
      if (lastBy && lastBy.team !== p.team && sim.now < sim.lastHitT + lvl.reaction) continue;

      if (p.team === receiving) {
        const plan = sim.plans[p.id];
        if (hitter === p && plan && !sim.leaveBall) {
          p.moveTo = plan.stance;
          const lead = plan.t - sim.now;
          if (lead <= SWING_LEAD && !(p.swing && !p.swing.resolved)) {
            sim.requestSwing(p, this.chooseShot(p, plan), plan);
          }
        } else {
          p.moveTo = this.coverPosition(p, hitterPlan);
        }
      } else {
        p.moveTo = this.waitPosition(p, hitterPlan);
      }
    }
  }

  /** Partner of the player taking the ball: stay level with them and cover the other half. */
  private coverPosition(p: Player, hitterPlan: Intercept | null): { x: number; z: number } {
    const deep = hitterPlan ? Math.abs(hitterPlan.ball.z) > 5 : Math.abs(p.z) > 5;
    const z = deep ? 7.3 : 3.0;
    let x = p.zone * 2.4;
    // Partner dragged into my half: slide towards the middle to cover the gap they leave.
    if (hitterPlan && hitterPlan.ball.x * p.zone > 0.6) x = p.zone * 1.2 - hitterPlan.ball.x * 0.15;
    if (this.sim.leaveBall) return { x: p.x, z: p.z };
    return { x: clamp(x, -4.4, 4.4), z: z * p.sideSign };
  }

  /** Where to wait while the opponents play the ball. */
  private waitPosition(p: Player, oppPlan: Intercept | null): { x: number; z: number } {
    const sim = this.sim;
    const oppDeep = !oppPlan || Math.abs(oppPlan.ball.z) > 5.5;
    const oppAttacking = oppPlan !== null && !oppDeep && (oppPlan.overhead || oppPlan.volley);
    const ballX = oppPlan ? oppPlan.ball.x : 0;
    const wantNet = sim.aggressive[p.team] && oppDeep;
    let z: number;
    let x: number;
    if (wantNet) {
      z = 2.8;
      x = p.zone * 2.2 + ballX * 0.22;
    } else if (oppAttacking) {
      // Smash or volley coming: get back and give yourself time off the glass.
      z = 8.2;
      x = p.zone * 2.5 + ballX * 0.1;
    } else {
      z = oppDeep ? 6.9 : 7.6;
      x = p.zone * 2.5 + ballX * 0.12;
    }
    return { x: clamp(x, -4.4, 4.4), z: z * p.sideSign };
  }

  private chooseShot(p: Player, plan: Intercept): ShotIntent {
    const sim = this.sim;
    const lvl = sim.levelOf(p);
    const r = sim.random;
    const ref = sim.match.referee;
    const opp = sim.teamPlayers(otherTeam(p.team));
    const oppAtNet = opp.filter((o) => Math.abs(o.z) < 5).length;
    const netDist = Math.abs(plan.ball.z);

    let type: ShotType = 'drive';
    let power: number;
    let cands: Candidate[];
    if (plan.overhead) {
      if (netDist < 6 && r() < lvl.smashRate) {
        type = 'smash';
        power = 0.45 + 0.55 * lvl.power;
        cands = [
          { x: -3.2, d: 6.8 },
          { x: 3.2, d: 6.8 },
          { x: 0, d: 7.2 },
        ];
      } else {
        power = 0.35 + 0.3 * lvl.power;
        cands = [
          { x: -3.8, d: 8.4 },
          { x: 3.8, d: 8.4 },
          { x: 0, d: 8.2 },
        ];
      }
    } else if (plan.volley) {
      power = 0.3 + 0.5 * lvl.power;
      cands = [
        { x: -3.6, d: 8 },
        { x: 3.6, d: 8 },
        { x: 0, d: 7.5 },
        { x: -4, d: 4.5 },
        { x: 4, d: 4.5 },
      ];
    } else if (ref.isServeInFlight) {
      // Return of serve: mostly deep and safe, sometimes a lob over the net player.
      if (r() < lvl.lobRate * 0.7) {
        type = 'lob';
        power = 0.5;
        cands = [
          { x: -3.2, d: 8.6 },
          { x: 3.2, d: 8.6 },
        ];
      } else {
        power = 0.35 + 0.4 * lvl.power;
        cands = [
          { x: -3.4, d: 7.8 },
          { x: 3.4, d: 7.8 },
          { x: 0, d: 6.5 },
        ];
      }
    } else if (oppAtNet >= 1 && r() < lvl.lobRate) {
      type = 'lob';
      power = 0.5;
      cands = [
        { x: -3.4, d: 8.6 },
        { x: 3.4, d: 8.6 },
        { x: 0, d: 8.8 },
      ];
    } else if (oppAtNet >= 1) {
      // Low and slow at the volleyers' feet, or past them down the line.
      power = 0.25 + 0.3 * lvl.power;
      cands = [
        { x: 0, d: 4.2 },
        { x: -2.6, d: 4.8 },
        { x: 2.6, d: 4.8 },
        { x: -3.9, d: 7.5 },
        { x: 3.9, d: 7.5 },
      ];
    } else {
      power = 0.4 + 0.5 * lvl.power;
      cands = [
        { x: -3.7, d: 8.3 },
        { x: 3.7, d: 8.3 },
        { x: 0, d: 8 },
        { x: -3.9, d: 6 },
        { x: 3.9, d: 6 },
      ];
    }

    let pick = cands[Math.floor(r() * cands.length)];
    if (r() < lvl.placement) {
      let bestOpen = -1;
      for (const c of cands) {
        const cz = p.dir * c.d;
        let open = Infinity;
        for (const o of opp) open = Math.min(open, Math.hypot(o.x - c.x, o.z - cz));
        open += r() * 0.8; // do not be perfectly predictable
        if (open > bestOpen) {
          bestOpen = open;
          pick = c;
        }
      }
    }
    // Harder to control a ball taken off the glass or far from the ideal height.
    const difficulty = 1 + (plan.afterWall ? 0.35 : 0) + Math.min(0.5, Math.abs(plan.ball.y - 1.0) * 0.3);
    const err = lvl.aimError * difficulty;
    const x = pick.x + sim.gauss() * err;
    const d = clamp(pick.d + sim.gauss() * err * 1.2, 1.2, COURT.halfLength + 2.5);
    return { type, power, target: { x, z: p.dir * d } };
  }
}
