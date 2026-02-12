import { describe, it, expect } from 'vitest';
import {
  getBlockStart,
  getBlockEnd,
  getNextBlockStart,
  snapTo15Min,
  snapForwardTo15Min,
  ticksToMs,
  msToTicks,
  formatDuration,
} from '../../src/utils/time.js';

describe('time utilities', () => {
  describe('getBlockStart', () => {
    it('should align to 00:00 for times between 00:00-07:59', () => {
      const date = new Date('2026-02-11T03:30:00.000Z');
      const result = getBlockStart(date);
      expect(result.getHours()).toBe(0);
      expect(result.getMinutes()).toBe(0);
      expect(result.getSeconds()).toBe(0);
    });

    it('should align to 08:00 for times between 08:00-15:59', () => {
      const date = new Date('2026-02-11T12:45:00.000Z');
      const result = getBlockStart(date);
      expect(result.getHours()).toBe(8);
      expect(result.getMinutes()).toBe(0);
    });

    it('should align to 16:00 for times between 16:00-23:59', () => {
      const date = new Date('2026-02-11T22:15:00.000Z');
      const result = getBlockStart(date);
      expect(result.getHours()).toBe(16);
      expect(result.getMinutes()).toBe(0);
    });

    it('should handle midnight exactly', () => {
      const date = new Date('2026-02-11T00:00:00.000Z');
      const result = getBlockStart(date);
      expect(result.getHours()).toBe(0);
      expect(result.getMinutes()).toBe(0);
    });
  });

  describe('getBlockEnd', () => {
    it('should return 8 hours after block start', () => {
      const start = new Date('2026-02-11T00:00:00.000Z');
      const end = getBlockEnd(start);
      expect(end.getHours()).toBe(8);
      expect(end.getDate()).toBe(start.getDate());
    });

    it('should handle day boundary crossing', () => {
      const start = new Date('2026-02-11T16:00:00.000Z');
      const end = getBlockEnd(start);
      expect(end.getTime() - start.getTime()).toBe(8 * 60 * 60 * 1000);
    });
  });

  describe('getNextBlockStart', () => {
    it('should return the end of the given block', () => {
      const start = new Date('2026-02-11T00:00:00.000Z');
      const next = getNextBlockStart(start);
      expect(next.getHours()).toBe(8);
    });
  });

  describe('snapTo15Min', () => {
    it('should snap :07 to :00', () => {
      const date = new Date('2026-02-11T10:07:00.000Z');
      const result = snapTo15Min(date);
      expect(result.getMinutes()).toBe(0);
    });

    it('should snap :08 to :15', () => {
      const date = new Date('2026-02-11T10:08:00.000Z');
      const result = snapTo15Min(date);
      expect(result.getMinutes()).toBe(15);
    });

    it('should snap :22 to :15', () => {
      const date = new Date('2026-02-11T10:22:00.000Z');
      const result = snapTo15Min(date);
      expect(result.getMinutes()).toBe(15);
    });

    it('should snap :23 to :30', () => {
      const date = new Date('2026-02-11T10:23:00.000Z');
      const result = snapTo15Min(date);
      expect(result.getMinutes()).toBe(30);
    });

    it('should keep :00 as :00', () => {
      const date = new Date('2026-02-11T10:00:00.000Z');
      const result = snapTo15Min(date);
      expect(result.getMinutes()).toBe(0);
    });

    it('should keep :15 as :15', () => {
      const date = new Date('2026-02-11T10:15:00.000Z');
      const result = snapTo15Min(date);
      expect(result.getMinutes()).toBe(15);
    });
  });

  describe('snapForwardTo15Min', () => {
    it('should snap :07 forward to :15', () => {
      const date = new Date('2026-02-11T10:07:00.000Z');
      const result = snapForwardTo15Min(date);
      expect(result.getMinutes()).toBe(15);
    });

    it('should keep :00 as :00', () => {
      const date = new Date('2026-02-11T10:00:00.000Z');
      const result = snapForwardTo15Min(date);
      expect(result.getMinutes()).toBe(0);
    });

    it('should keep :15 as :15', () => {
      const date = new Date('2026-02-11T10:15:00.000Z');
      const result = snapForwardTo15Min(date);
      expect(result.getMinutes()).toBe(15);
    });

    it('should snap :01 forward to :15', () => {
      const date = new Date('2026-02-11T10:01:00.000Z');
      const result = snapForwardTo15Min(date);
      expect(result.getMinutes()).toBe(15);
    });

    it('should snap :31 forward to :45', () => {
      const date = new Date('2026-02-11T10:31:00.000Z');
      const result = snapForwardTo15Min(date);
      expect(result.getMinutes()).toBe(45);
    });

    it('should zero out seconds and milliseconds', () => {
      const date = new Date('2026-02-11T10:07:45.123Z');
      const result = snapForwardTo15Min(date);
      expect(result.getSeconds()).toBe(0);
      expect(result.getMilliseconds()).toBe(0);
    });
  });

  describe('ticksToMs', () => {
    it('should convert ticks to milliseconds', () => {
      expect(ticksToMs(10000)).toBe(1);        // 1ms
      expect(ticksToMs(10000000)).toBe(1000);   // 1 second
      expect(ticksToMs(600000000)).toBe(60000);  // 1 minute
    });

    it('should handle 2-hour movie ticks', () => {
      // 2 hours = 7200 seconds = 72,000,000,000 ticks
      expect(ticksToMs(72000000000)).toBe(7200000);
    });

    it('should handle zero', () => {
      expect(ticksToMs(0)).toBe(0);
    });
  });

  describe('msToTicks', () => {
    it('should convert milliseconds to ticks', () => {
      expect(msToTicks(1)).toBe(10000);
      expect(msToTicks(1000)).toBe(10000000);
    });

    it('should be the inverse of ticksToMs', () => {
      const ticks = 72000000000;
      expect(msToTicks(ticksToMs(ticks))).toBe(ticks);
    });
  });

  describe('formatDuration', () => {
    it('should format hours and minutes', () => {
      expect(formatDuration(7200000)).toBe('2h 0m');   // 2 hours
      expect(formatDuration(5400000)).toBe('1h 30m');   // 1.5 hours
    });

    it('should format minutes only when under 1 hour', () => {
      expect(formatDuration(2700000)).toBe('45m');
      expect(formatDuration(60000)).toBe('1m');
    });

    it('should handle zero', () => {
      expect(formatDuration(0)).toBe('0m');
    });
  });
});
