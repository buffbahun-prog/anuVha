interface TransferSample {
  bytes: number;
  time: number;
}

export class SpeedCalculator {
  private samples: TransferSample[] = [];
  private readonly WINDOW_SIZE_MS = 1000; // 1 second rolling window
  private startTime: number | null = null;

  /**
   * Call this only when an ACK is received.
   */
  addSample(bytes: number): void {
    const now = performance.now();
    if (this.startTime === null) this.startTime = now;
    
    this.samples.push({ bytes, time: now });
    this.cleanOldSamples(now);
  }

  /**
   * Returns current speed in Bytes Per Second.
   * Call this from your UI timer (e.g., every 200ms) to detect 0 Mbps drops.
   */
  getCurrentSpeed(): number {
    const now = performance.now();
    this.cleanOldSamples(now);

    if (this.samples.length === 0 || this.startTime === null) {
      return 0;
    }

    const totalBytes = this.samples.reduce((sum, s) => sum + s.bytes, 0);
    
    // Calculate the actual duration to divide by.
    // This handles the "Cold Start": if we've only been running for 200ms, 
    // we divide by 0.2 instead of 1.0 to get the real rate immediately.
    const timeElapsedSinceStart = now - this.startTime;
    const effectiveWindow = Math.min(timeElapsedSinceStart, this.WINDOW_SIZE_MS);

    // Convert ms to seconds for the divisor
    return totalBytes / (effectiveWindow / 1000);
  }

  private cleanOldSamples(now: number): void {
    const threshold = now - this.WINDOW_SIZE_MS;
    // Fast O(1) check: if the oldest sample is still fresh, do nothing.
    while (this.samples.length > 0 && this.samples[0].time < threshold) {
      this.samples.shift();
    }
  }

  reset(): void {
    this.samples = [];
    this.startTime = null;
  }
}