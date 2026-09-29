import { describe, expect, it } from 'vitest';
import { EdgeScrollMotion } from './mobile-terminal-scroll';

describe('EdgeScrollMotion', () => {
  it('preserves partial lines across release and coasts equally at 60 and 120 Hz', () => {
    const travel = (interval: number) => {
      const motion = new EdgeScrollMotion(200, 0);
      let lines = motion.move(165, 40);
      expect(lines).toBe(1);
      expect(motion.release(40)).toBe(true);
      for (let time = 40 + interval; time < 1040; time += interval) lines += motion.step(time) ?? 0;
      lines += motion.step(1040) ?? 0;
      return lines;
    };
    expect(travel(1000 / 60)).toBe(travel(1000 / 120));
  });

  it('uses the recent stroke rather than the speed of the whole drag', () => {
    const motion = new EdgeScrollMotion(500, 0);
    motion.move(300, 20);
    motion.move(282, 200);
    motion.move(264, 300);
    expect(motion.release(300)).toBe(true);
    expect(motion.step(400)).toBeLessThanOrEqual(1);
  });

  it('launches a reversed stroke in its new direction', () => {
    const motion = new EdgeScrollMotion(200, 0);
    motion.move(100, 50);
    motion.move(136, 90);
    expect(motion.release(90)).toBe(true);
    expect(motion.step(190)).toBeLessThan(0);
  });

  it('includes a short pause in release velocity and suppresses a held release', () => {
    const immediate = new EdgeScrollMotion(200, 0);
    const delayed = new EdgeScrollMotion(200, 0);
    const held = new EdgeScrollMotion(200, 0);
    for (const motion of [immediate, delayed, held]) motion.move(164, 40);
    expect(immediate.release(40)).toBe(true);
    expect(delayed.release(80)).toBe(true);
    expect(held.release(120)).toBe(false);
    expect(delayed.step(180)).toBeLessThan(immediate.step(140)!);
  });

  it('does not fling a stationary touch or a slow drag', () => {
    const motion = new EdgeScrollMotion(200, 0);
    expect(motion.release(40)).toBe(false);
    motion.move(199, 40);
    expect(motion.release(40)).toBe(false);
  });
});
