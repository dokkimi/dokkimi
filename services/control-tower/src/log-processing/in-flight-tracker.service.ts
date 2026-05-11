import { Injectable } from '@nestjs/common';

@Injectable()
export class InFlightTrackerService {
  private count = 0;

  increment(): void {
    this.count++;
  }

  decrement(): void {
    this.count = Math.max(0, this.count - 1);
  }

  get inFlightCount(): number {
    return this.count;
  }

  async trackAsync<T>(fn: () => Promise<T>): Promise<T> {
    this.increment();
    try {
      return await fn();
    } finally {
      this.decrement();
    }
  }
}
