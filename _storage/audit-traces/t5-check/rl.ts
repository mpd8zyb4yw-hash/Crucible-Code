import { EventEmitter } from 'events';
class SlidingWindowRateLimiter extends EventEmitter {
  private window: number;
  private currentWindow: number;
  private maxRequests: number;
  private requestCount: number;
  private keys: Set<string>;
  constructor(maxRequests: number, window: number) {
    this.maxRequests = maxRequests;
    this.window = window;
    this.currentWindow = 0;
    this.requestCount = 0;
    this.keys = new Set();
  }
  tryAcquire(key: string): boolean {
    if (this.keys.has(key)) {
      this.currentWindow += 1;
      if (this.currentWindow > this.window) { this.currentWindow = 0; this.requestCount++; }
      return false;
    } else {
      this.keys.add(key); this.currentWindow = 0; this.requestCount++; return true;
    }
  }
}
export { SlidingWindowRateLimiter };
