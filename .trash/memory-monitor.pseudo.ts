/**
 * Memory Monitor - Production Memory Profiling
 *
 * Responsibilities:
 * - Track heap usage per session
 * - Detect memory leaks (heap growth over time)
 * - Enforce memory budget (<10MB per session)
 * - Emit alerts when thresholds exceeded
 * - Log memory stats for analysis
 *
 * Critical: Non-intrusive monitoring (<1% overhead)
 */

import { EventEmitter } from 'events';

interface MemoryStats {
  heapUsed: number;         // Current heap usage (bytes)
  heapTotal: number;        // Total heap allocated (bytes)
  external: number;         // C++ objects bound to JS (bytes)
  rss: number;              // Resident Set Size (total memory) (bytes)
  timestamp: number;        // When measurement taken (ms)
}

interface SessionMemory {
  sessionId: string;
  heapUsed: number;
  timestamp: number;
  samples: number;          // Number of measurements taken
}

interface MemoryBudget {
  perSession: number;       // Max heap per session (bytes)
  totalSystem: number;      // Max total heap (bytes)
  alertThreshold: number;   // % of budget before alert (0-100)
}

interface MemoryAlert {
  type: 'session_exceeded' | 'system_exceeded' | 'leak_detected' | 'gc_pressure';
  sessionId?: string;
  currentUsage: number;
  budget: number;
  message: string;
  severity: 'warning' | 'error' | 'critical';
}

class MemoryMonitor extends EventEmitter {
  private sessionMemory: Map<string, SessionMemory> = new Map();
  private measurements: MemoryStats[] = [];
  private budget: MemoryBudget;
  private samplingInterval: number;
  private samplingTimer?: NodeJS.Timer;
  private heapGrowthHistory: number[] = [];

  constructor(
    budget: MemoryBudget = {
      perSession: 10 * 1024 * 1024,  // 10MB
      totalSystem: 150 * 1024 * 1024, // 150MB (15 sessions × 10MB)
      alertThreshold: 80  // Alert at 80% of budget
    },
    samplingInterval: number = 60000  // Sample every 1 minute
  ) {
    super();
    this.budget = budget;
    this.samplingInterval = samplingInterval;
  }

  /**
   * Start monitoring memory usage
   */
  start(): void {
    if (this.samplingTimer) {
      return; // Already started
    }

    // Take initial measurement
    this.sample();

    // Start periodic sampling
    this.samplingTimer = setInterval(() => {
      this.sample();
    }, this.samplingInterval);

    this.emit('monitoring:started');
  }

  /**
   * Stop monitoring
   */
  stop(): void {
    if (this.samplingTimer) {
      clearInterval(this.samplingTimer);
      this.samplingTimer = undefined;
    }

    this.emit('monitoring:stopped');
  }

  /**
   * Take a memory measurement sample
   */
  private sample(): void {
    const usage = process.memoryUsage();
    const stats: MemoryStats = {
      heapUsed: usage.heapUsed,
      heapTotal: usage.heapTotal,
      external: usage.external,
      rss: usage.rss,
      timestamp: Date.now()
    };

    this.measurements.push(stats);

    // Keep only last 60 samples (1 hour at 1 min intervals)
    if (this.measurements.length > 60) {
      this.measurements.shift();
    }

    // Track heap growth
    this.trackHeapGrowth(stats.heapUsed);

    // Check for issues
    this.checkBudgets(stats);
    this.checkLeaks();
    this.checkGCPressure(stats);

    this.emit('sample:taken', stats);
  }

  /**
   * Track heap growth over time
   */
  private trackHeapGrowth(heapUsed: number): void {
    this.heapGrowthHistory.push(heapUsed);

    // Keep only last 10 samples (10 minutes)
    if (this.heapGrowthHistory.length > 10) {
      this.heapGrowthHistory.shift();
    }
  }

  /**
   * Check if memory budgets are exceeded
   */
  private checkBudgets(stats: MemoryStats): void {
    // Check system-wide budget
    const systemUsagePercent = (stats.heapUsed / this.budget.totalSystem) * 100;

    if (systemUsagePercent >= 100) {
      this.emitAlert({
        type: 'system_exceeded',
        currentUsage: stats.heapUsed,
        budget: this.budget.totalSystem,
        message: `System heap exceeded: ${this.formatBytes(stats.heapUsed)} / ${this.formatBytes(this.budget.totalSystem)}`,
        severity: 'critical'
      });
    } else if (systemUsagePercent >= this.budget.alertThreshold) {
      this.emitAlert({
        type: 'system_exceeded',
        currentUsage: stats.heapUsed,
        budget: this.budget.totalSystem,
        message: `System heap at ${systemUsagePercent.toFixed(0)}% of budget`,
        severity: 'warning'
      });
    }

    // Check per-session budgets
    for (const [sessionId, sessionMem] of this.sessionMemory.entries()) {
      const sessionPercent = (sessionMem.heapUsed / this.budget.perSession) * 100;

      if (sessionPercent >= 100) {
        this.emitAlert({
          type: 'session_exceeded',
          sessionId,
          currentUsage: sessionMem.heapUsed,
          budget: this.budget.perSession,
          message: `Session ${sessionId} exceeded: ${this.formatBytes(sessionMem.heapUsed)} / ${this.formatBytes(this.budget.perSession)}`,
          severity: 'error'
        });
      } else if (sessionPercent >= this.budget.alertThreshold) {
        this.emitAlert({
          type: 'session_exceeded',
          sessionId,
          currentUsage: sessionMem.heapUsed,
          budget: this.budget.perSession,
          message: `Session ${sessionId} at ${sessionPercent.toFixed(0)}% of budget`,
          severity: 'warning'
        });
      }
    }
  }

  /**
   * Check for memory leaks (steady heap growth)
   */
  private checkLeaks(): void {
    if (this.heapGrowthHistory.length < 5) {
      return; // Not enough data
    }

    // Calculate linear regression slope (trend)
    const n = this.heapGrowthHistory.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;

    for (let i = 0; i < n; i++) {
      sumX += i;
      sumY += this.heapGrowthHistory[i];
      sumXY += i * this.heapGrowthHistory[i];
      sumX2 += i * i;
    }

    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);

    // Positive slope = heap growing
    // Threshold: >1MB growth per sample = leak
    const growthPerSample = slope;
    const growthPerMinute = growthPerSample; // 1 sample = 1 minute

    if (growthPerMinute > 1 * 1024 * 1024) { // >1MB/min
      this.emitAlert({
        type: 'leak_detected',
        currentUsage: this.heapGrowthHistory[n - 1],
        budget: this.budget.totalSystem,
        message: `Possible memory leak: heap growing ${this.formatBytes(growthPerMinute)}/min`,
        severity: 'error'
      });
    }
  }

  /**
   * Check for GC pressure (high frequency GC)
   */
  private checkGCPressure(stats: MemoryStats): void {
    // If heap is near total, GC is struggling
    const heapUsagePercent = (stats.heapUsed / stats.heapTotal) * 100;

    if (heapUsagePercent > 90) {
      this.emitAlert({
        type: 'gc_pressure',
        currentUsage: stats.heapUsed,
        budget: stats.heapTotal,
        message: `High GC pressure: heap ${heapUsagePercent.toFixed(0)}% full`,
        severity: 'warning'
      });
    }
  }

  /**
   * Record memory usage for a specific session
   */
  recordSessionUsage(sessionId: string, heapUsed: number): void {
    const existing = this.sessionMemory.get(sessionId);

    if (existing) {
      existing.heapUsed = heapUsed;
      existing.timestamp = Date.now();
      existing.samples++;
    } else {
      this.sessionMemory.set(sessionId, {
        sessionId,
        heapUsed,
        timestamp: Date.now(),
        samples: 1
      });
    }
  }

  /**
   * Remove session from tracking (on session end)
   */
  removeSession(sessionId: string): void {
    this.sessionMemory.delete(sessionId);
    this.emit('session:removed', sessionId);
  }

  /**
   * Get current memory statistics
   */
  getStats(): {
    current: MemoryStats;
    sessions: SessionMemory[];
    budget: MemoryBudget;
    heapGrowthRate: number; // bytes/minute
  } {
    const current = this.measurements[this.measurements.length - 1];
    const sessions = Array.from(this.sessionMemory.values());

    // Calculate heap growth rate
    let heapGrowthRate = 0;
    if (this.heapGrowthHistory.length >= 2) {
      const first = this.heapGrowthHistory[0];
      const last = this.heapGrowthHistory[this.heapGrowthHistory.length - 1];
      const timeDiff = this.heapGrowthHistory.length - 1; // minutes
      heapGrowthRate = (last - first) / timeDiff;
    }

    return {
      current,
      sessions,
      budget: this.budget,
      heapGrowthRate
    };
  }

  /**
   * Force garbage collection (requires --expose-gc flag)
   */
  forceGC(): boolean {
    if (global.gc) {
      global.gc();
      this.emit('gc:forced');
      return true;
    }
    return false;
  }

  /**
   * Get heap snapshot for analysis (requires v8 module)
   */
  async takeHeapSnapshot(filename: string): Promise<void> {
    const v8 = require('v8');
    const fs = require('fs');
    const stream = v8.writeHeapSnapshot(filename);
    this.emit('snapshot:taken', filename);
  }

  /**
   * Emit memory alert
   */
  private emitAlert(alert: MemoryAlert): void {
    this.emit('alert', alert);

    // Also emit severity-specific events
    this.emit(`alert:${alert.severity}`, alert);
  }

  /**
   * Format bytes for human readability
   */
  private formatBytes(bytes: number): string {
    if (bytes >= 1024 * 1024 * 1024) {
      return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    } else if (bytes >= 1024 * 1024) {
      return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    } else if (bytes >= 1024) {
      return `${(bytes / 1024).toFixed(2)} KB`;
    } else {
      return `${bytes} B`;
    }
  }

  /**
   * Log memory statistics to console
   */
  logStats(): void {
    const stats = this.getStats();

    console.log('=== Memory Statistics ===');
    console.log(`Heap Used: ${this.formatBytes(stats.current.heapUsed)}`);
    console.log(`Heap Total: ${this.formatBytes(stats.current.heapTotal)}`);
    console.log(`RSS: ${this.formatBytes(stats.current.rss)}`);
    console.log(`Growth Rate: ${this.formatBytes(stats.heapGrowthRate)}/min`);
    console.log(`Sessions: ${stats.sessions.length}`);

    for (const session of stats.sessions) {
      console.log(`  - ${session.sessionId}: ${this.formatBytes(session.heapUsed)}`);
    }

    console.log(`Budget: ${this.formatBytes(this.budget.perSession)}/session, ${this.formatBytes(this.budget.totalSystem)} total`);
  }
}

export default MemoryMonitor;
export { MemoryStats, SessionMemory, MemoryBudget, MemoryAlert };
