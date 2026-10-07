import { Vector3 } from 'three';
import { BALL, COURT, PHYSICS } from '../utils/Constants';
import type { BallEvent, BallState } from './BallPhysics';

const R = BALL.RADIUS;
const TAPE_CONTACT = BALL.RADIUS + PHYSICS.TAPE_RADIUS;
const n = new Vector3();

/** Net top height at lateral position x (34" center, 36" at sidelines, parabolic sag). */
export function netHeightAt(x: number): number {
  const t = x / COURT.HALF_WIDTH;
  return COURT.NET_HEIGHT_CENTER + (COURT.NET_HEIGHT_SIDELINE - COURT.NET_HEIGHT_CENTER) * t * t;
}

export function isWithinNetSpan(x: number): boolean {
  return Math.abs(x) <= COURT.NET_POST_X;
}

/** Reflects velocity off a surface normal with restitution e and tangential retention kt. */
function reflect(vel: Vector3, normal: Vector3, e: number, kt: number): void {
  const vn = vel.dot(normal);
  if (vn >= 0) return;
  // v = vt + vn*n  ->  kt*vt - e*vn*n
  const tx = vel.x - vn * normal.x;
  const ty = vel.y - vn * normal.y;
  const tz = vel.z - vn * normal.z;
  vel.set(tx * kt - e * vn * normal.x, ty * kt - e * vn * normal.y, tz * kt - e * vn * normal.z);
}

function hitTape(s: BallState, x: number, dy: number, dz: number, out?: BallEvent[]): void {
  const d = Math.hypot(dy, dz) || 1;
  n.set(0, dy / d, dz / d);
  const h = netHeightAt(x);
  s.pos.set(x, h + n.y * TAPE_CONTACT, n.z * TAPE_CONTACT);
  reflect(s.vel, n, PHYSICS.TAPE_RESTITUTION, 0.72);
  s.spin.multiplyScalar(0.4);
  out?.push({ type: 'net', pos: s.pos.clone(), tape: true });
}

function hitNetBody(s: BallState, x: number, y: number, side: number, out?: BallEvent[]): void {
  s.pos.set(x, Math.max(y, R), side * (R + 0.002));
  s.vel.z = -s.vel.z * PHYSICS.NET_RESTITUTION;
  s.vel.x *= 0.35;
  s.vel.y = Math.min(s.vel.y, 0) * 0.3;
  s.spin.multiplyScalar(0.2);
  out?.push({ type: 'net', pos: s.pos.clone(), tape: false });
}

/**
 * Net collision. Uses the swept segment prev -> pos so fast balls cannot tunnel through.
 * The net is a vertical plane at z=0 up to netHeightAt(x), topped by a cylindrical tape.
 * Balls passing outside the posts are not blocked (around-the-post shots are legal).
 */
export function collideNet(s: BallState, prev: Vector3, out?: BallEvent[]): boolean {
  const z0 = prev.z;
  const z1 = s.pos.z;

  if ((z0 > 0) !== (z1 > 0)) {
    const t = z0 / (z0 - z1);
    const xc = prev.x + (s.pos.x - prev.x) * t;
    const yc = prev.y + (s.pos.y - prev.y) * t;
    if (isWithinNetSpan(xc)) {
      const h = netHeightAt(xc);
      const side = z0 > 0 ? 1 : -1;
      if (yc < h) {
        hitNetBody(s, xc, yc, side, out);
        return true;
      }
      const dy = yc - h;
      if (dy < TAPE_CONTACT) {
        hitTape(s, xc, dy, side * Math.sqrt(TAPE_CONTACT * TAPE_CONTACT - dy * dy), out);
        return true;
      }
    }
  }

  // Proximity checks for slow balls resting against or rolling over the net.
  const { x, y, z } = s.pos;
  if (!isWithinNetSpan(x) || Math.abs(z) > TAPE_CONTACT + 0.01) return false;
  const h = netHeightAt(x);
  const dy = y - h;
  if (dy > 0) {
    if (Math.hypot(dy, z) < TAPE_CONTACT && s.vel.dot(n.set(0, dy, z).normalize()) < 0) {
      hitTape(s, x, dy, z, out);
      return true;
    }
  } else if (Math.abs(z) < R) {
    const side = z !== 0 ? Math.sign(z) : -Math.sign(s.vel.z || 1);
    if (s.vel.z * side < 0) {
      hitNetBody(s, x, y, side, out);
    } else {
      s.pos.z = side * (R + 0.002);
    }
    return true;
  }
  return false;
}

/** Court surface collision with spin-aware friction. Returns true if a real bounce occurred. */
export function collideGround(s: BallState, out?: BallEvent[]): boolean {
  if (s.pos.y >= R) return false;
  s.pos.y = R;
  if (s.vel.y >= 0) return false;

  const impact = -s.vel.y;
  if (impact < PHYSICS.MIN_BOUNCE_SPEED) {
    s.vel.y = 0;
    s.rolling = true;
    return false;
  }
  s.vel.y = impact * PHYSICS.RESTITUTION;

  // Contact point velocity = v + omega x (-R * up) => (vx + R*wz, vz - R*wx) in the plane.
  const cx = s.vel.x + R * s.spin.z;
  const cz = s.vel.z - R * s.spin.x;
  const f = PHYSICS.GROUND_FRICTION;
  s.vel.x -= f * cx;
  s.vel.z -= f * cz;
  s.spin.multiplyScalar(PHYSICS.SPIN_KEEP_BOUNCE);
  s.bounceCount++;
  out?.push({ type: 'bounce', pos: s.pos.clone(), speed: impact });
  return true;
}
