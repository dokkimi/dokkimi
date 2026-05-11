import { InFlightTrackerService } from './in-flight-tracker.service';

describe('InFlightTrackerService', () => {
  let tracker: InFlightTrackerService;

  beforeEach(() => {
    tracker = new InFlightTrackerService();
  });

  it('should start with count 0', () => {
    expect(tracker.inFlightCount).toBe(0);
  });

  it('should increment and decrement', () => {
    tracker.increment();
    expect(tracker.inFlightCount).toBe(1);
    tracker.increment();
    expect(tracker.inFlightCount).toBe(2);
    tracker.decrement();
    expect(tracker.inFlightCount).toBe(1);
    tracker.decrement();
    expect(tracker.inFlightCount).toBe(0);
  });

  it('should clamp decrement at 0', () => {
    tracker.decrement();
    expect(tracker.inFlightCount).toBe(0);
    tracker.decrement();
    expect(tracker.inFlightCount).toBe(0);
  });

  describe('trackAsync', () => {
    it('should increment before and decrement after the function', async () => {
      let duringCount: number | undefined;

      await tracker.trackAsync(async () => {
        duringCount = tracker.inFlightCount;
        return 'result';
      });

      expect(duringCount).toBe(1);
      expect(tracker.inFlightCount).toBe(0);
    });

    it('should return the function result', async () => {
      const result = await tracker.trackAsync(async () => 42);
      expect(result).toBe(42);
    });

    it('should decrement even when the function throws', async () => {
      await expect(
        tracker.trackAsync(async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect(tracker.inFlightCount).toBe(0);
    });

    it('should track multiple concurrent async operations', async () => {
      let maxCount = 0;
      const track = () =>
        tracker.trackAsync(async () => {
          maxCount = Math.max(maxCount, tracker.inFlightCount);
          await new Promise((r) => setTimeout(r, 10));
        });

      await Promise.all([track(), track(), track()]);
      expect(maxCount).toBe(3);
      expect(tracker.inFlightCount).toBe(0);
    });
  });
});
