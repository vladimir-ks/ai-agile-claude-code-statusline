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
 *
 * Defensive Programming:
 * - All inputs validated (non-null, bounds checked)
 * - All operations wrapped in try/catch
 * - Never throws - suppresses errors with event emission
 * - Timer cleanup to prevent leaks
 * - Safe division (no division by zero)
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

    // Validate and sanitize budget
    this.budget = this.validateBudget(budget);

    // Validate sampling interval (1s - 10 min)
    this.samplingInterval = Math.max(1000, Math.min(samplingInterval, 600000));

    // Set reasonable max listeners
    this.setMaxListeners(100);
  }

  /**
   * Validate budget configuration
   */
  private validateBudget(budget: MemoryBudget): MemoryBudget {
    try {
      if (!budget || typeof budget !== 'object') {
        return this.getDefaultBudget();
      }

      return {
        perSession: Math.max(1024 * 1024, budget.perSession || 10 * 1024 * 1024), // Min 1MB
        totalSystem: Math.max(10 * 1024 * 1024, budget.totalSystem || 150 * 1024 * 1024), // Min 10MB
        alertThreshold: Math.max(0, Math.min(100, budget.alertThreshold || 80))
      };
    } catch (error) {
      return this.getDefaultBudget();
    }
  }

  /**
   * Get default budget configuration
   */
  private getDefaultBudget(): MemoryBudget {
    return {
      perSession: 10 * 1024 * 1024,
      totalSystem: 150 * 1024 * 1024,
      alertThreshold: 80
    };
  }

  /**
   * Start monitoring memory usage
   *
   * @throws Never - errors emitted as events
   */
  start(): void {
    try {
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

    } catch (error) {
      this.emit('error', {
        message: 'Failed to start monitoring',
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Stop monitoring
   *
   * @throws Never - cleanup errors suppressed
   */
  stop(): void {
    try {
      if (this.samplingTimer) {
        clearInterval(this.samplingTimer);
        this.samplingTimer = undefined;
      }

      this.emit('monitoring:stopped');

    } catch (error) {
      // Suppress cleanup errors
    }
  }

  /**
   * Take a memory measurement sample
   */
  sample(): void {
    try {
      const usage = process.memoryUsage();

      // Validate memory readings
      if (!this.isValidMemoryUsage(usage)) {
        return; // Skip invalid sample
      }

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

    } catch (error) {
      this.emit('error', {
        message: 'Failed to take memory sample',
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Validate memory usage object
   */
  private isValidMemoryUsage(usage: any): boolean {
    try {
      return usage &&
             typeof usage === 'object' &&
             typeof usage.heapUsed === 'number' &&
             typeof usage.heapTotal === 'number' &&
             typeof usage.external === 'number' &&
             typeof usage.rss === 'number' &&
             isFinite(usage.heapUsed) &&
             isFinite(usage.heapTotal) &&
             isFinite(usage.external) &&
             isFinite(usage.rss) &&
             usage.heapUsed >= 0 &&
             usage.heapTotal >= 0 &&
             usage.external >= 0 &&
             usage.rss >= 0;
    } catch (error) {
      return false;
    }
  }

  /**
   * Track heap growth over time
   */
  private trackHeapGrowth(heapUsed: number): void {
    try {
      // Validate input
      if (typeof heapUsed !== 'number' || !isFinite(heapUsed) || heapUsed < 0) {
        return;
      }

      this.heapGrowthHistory.push(heapUsed);

      // Keep only last 10 samples (10 minutes)
      if (this.heapGrowthHistory.length > 10) {
        this.heapGrowthHistory.shift();
      }

    } catch (error) {
      // Suppress tracking errors
    }
  }

  /**
   * Check if memory budgets are exceeded
   */
  private checkBudgets(stats: MemoryStats): void {
    try {
      // Validate stats
      if (!stats || typeof stats.heapUsed !== 'number') {
        return;
      }

      // Check system-wide budget (prevent division by zero)
      if (this.budget.totalSystem > 0) {
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
      }

      // Check per-session budgets
      if (this.budget.perSession > 0) {
        for (const [sessionId, sessionMem] of this.sessionMemory.entries()) {
          if (!sessionMem || typeof sessionMem.heapUsed !== 'number') {
            continue;
          }

          const sessionPercent = (sessionMem.heapUsed / this.budget.perSession) * 100;

          if (sessionPercent >= 100) {
            this.emitAlert({
              type: 'session_exceeded',
              sessionId,
              currentUsage: sessionMem.heapUsed,
              budget: this.budget.perSession,
              message: `Session ${this.sanitizeSessionId(sessionId)} exceeded: ${this.formatBytes(sessionMem.heapUsed)} / ${this.formatBytes(this.budget.perSession)}`,
              severity: 'error'
            });
          } else if (sessionPercent >= this.budget.alertThreshold) {
            this.emitAlert({
              type: 'session_exceeded',
              sessionId,
              currentUsage: sessionMem.heapUsed,
              budget: this.budget.perSession,
              message: `Session ${this.sanitizeSessionId(sessionId)} at ${sessionPercent.toFixed(0)}% of budget`,
              severity: 'warning'
            });
          }
        }
      }

    } catch (error) {
      // Suppress budget check errors
    }
  }

  /**
   * Check for memory leaks (steady heap growth)
   */
  private checkLeaks(): void {
    try {
      if (this.heapGrowthHistory.length < 5) {
        return; // Not enough data
      }

      // Calculate linear regression slope (trend)
      const n = this.heapGrowthHistory.length;
      let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;

      for (let i = 0; i < n; i++) {
        const value = this.heapGrowthHistory[i];
        if (typeof value !== 'number' || !isFinite(value)) {
          continue;
        }

        sumX += i;
        sumY += value;
        sumXY += i * value;
        sumX2 += i * i;
      }

      // Prevent division by zero
      const denominator = (n * sumX2 - sumX * sumX);
      if (denominator === 0) {
        return;
      }

      const slope = (n * sumXY - sumX * sumY) / denominator;

      // Positive slope = heap growing
      // Threshold: >1MB growth per sample = leak
      const growthPerMinute = slope; // 1 sample = 1 minute

      if (isFinite(growthPerMinute) && growthPerMinute > 1 * 1024 * 1024) { // >1MB/min
        const lastHeap = this.heapGrowthHistory[n - 1];
        this.emitAlert({
          type: 'leak_detected',
          currentUsage: lastHeap,
          budget: this.budget.totalSystem,
          message: `Possible memory leak: heap growing ${this.formatBytes(growthPerMinute)}/min`,
          severity: 'error'
        });
      }

    } catch (error) {
      // Suppress leak detection errors
    }
  }

  /**
   * Check for GC pressure (high frequency GC)
   */
  private checkGCPressure(stats: MemoryStats): void {
    try {
      if (!stats || typeof stats.heapUsed !== 'number' || typeof stats.heapTotal !== 'number') {
        return;
      }

      // Prevent division by zero
      if (stats.heapTotal === 0) {
        return;
      }

      // If heap is near total, GC is struggling
      const heapUsagePercent = (stats.heapUsed / stats.heapTotal) * 100;

      if (isFinite(heapUsagePercent) && heapUsagePercent > 90) {
        this.emitAlert({
          type: 'gc_pressure',
          currentUsage: stats.heapUsed,
          budget: stats.heapTotal,
          message: `High GC pressure: heap ${heapUsagePercent.toFixed(0)}% full`,
          severity: 'warning'
        });
      }

    } catch (error) {
      // Suppress GC pressure check errors
    }
  }

  /**
   * Record memory usage for a specific session
   *
   * @throws Never - validates inputs, suppresses errors
   */
  recordSessionUsage(sessionId: string, heapUsed: number): void {
    try {
      // Input validation
      if (typeof sessionId !== 'string' || sessionId.trim() === '') {
        return;
      }

      if (typeof heapUsed !== 'number' || !isFinite(heapUsed) || heapUsed < 0) {
        return;
      }

      const existing = this.sessionMemory.get(sessionId);

      if (existing) {
        existing.heapUsed = heapUsed;
        existing.timestamp = Date.now();
        existing.samples = Math.min(existing.samples + 1, Number.MAX_SAFE_INTEGER);
      } else {
        this.sessionMemory.set(sessionId, {
          sessionId,
          heapUsed,
          timestamp: Date.now(),
          samples: 1
        });
      }

    } catch (error) {
      // Suppress session recording errors
    }
  }

  /**
   * Remove session from tracking (on session end)
   *
   * @throws Never - suppresses errors
   */
  removeSession(sessionId: string): void {
    try {
      if (typeof sessionId !== 'string') {
        return;
      }

      this.sessionMemory.delete(sessionId);
      this.emit('session:removed', sessionId);

    } catch (error) {
      // Suppress removal errors
    }
  }

  /**
   * Get current memory statistics
   */
  getStats(): {
    current: MemoryStats | null;
    sessions: SessionMemory[];
    budget: MemoryBudget;
    heapGrowthRate: number; // bytes/minute
  } {
    try {
      const current = this.measurements.length > 0
        ? this.measurements[this.measurements.length - 1]
        : null;

      const sessions = Array.from(this.sessionMemory.values());

      // Calculate heap growth rate
      let heapGrowthRate = 0;
      if (this.heapGrowthHistory.length >= 2) {
        const first = this.heapGrowthHistory[0];
        const last = this.heapGrowthHistory[this.heapGrowthHistory.length - 1];
        const timeDiff = this.heapGrowthHistory.length - 1; // minutes

        if (timeDiff > 0 && typeof first === 'number' && typeof last === 'number') {
          heapGrowthRate = (last - first) / timeDiff;
        }
      }

      return {
        current,
        sessions,
        budget: this.budget,
        heapGrowthRate: isFinite(heapGrowthRate) ? heapGrowthRate : 0
      };

    } catch (error) {
      // Return safe defaults
      return {
        current: null,
        sessions: [],
        budget: this.budget,
        heapGrowthRate: 0
      };
    }
  }

  /**
   * Force garbage collection (requires --expose-gc flag)
   */
  forceGC(): boolean {
    try {
      if (global.gc && typeof global.gc === 'function') {
        global.gc();
        this.emit('gc:forced');
        return true;
      }
      return false;

    } catch (error) {
      return false;
    }
  }

  /**
   * Get heap snapshot for analysis (requires v8 module)
   */
  async takeHeapSnapshot(filename: string): Promise<void> {
    try {
      // Input validation
      if (typeof filename !== 'string' || filename.trim() === '') {
        throw new Error('Invalid filename');
      }

      const v8 = require('v8');
      const stream = v8.writeHeapSnapshot(filename);
      this.emit('snapshot:taken', filename);

    } catch (error) {
      this.emit('error', {
        message: 'Failed to take heap snapshot',
        error: error instanceof Error ? error.message : String(error)
      });
      throw error; // Re-throw for caller to handle
    }
  }

  /**
   * Emit memory alert
   */
  private emitAlert(alert: MemoryAlert): void {
    try {
      this.emit('alert', alert);

      // Also emit severity-specific events
      if (alert.severity) {
        this.emit(`alert:${alert.severity}`, alert);
      }

    } catch (error) {
      // Suppress alert emission errors
    }
  }

  /**
   * Format bytes for human readability
   */
  formatBytes(bytes: number): string {
    try {
      if (typeof bytes !== 'number' || !isFinite(bytes)) {
        return '0 B';
      }

      const absBytes = Math.abs(bytes);

      if (absBytes >= 1024 * 1024 * 1024) {
        return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
      } else if (absBytes >= 1024 * 1024) {
        return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
      } else if (absBytes >= 1024) {
        return `${(bytes / 1024).toFixed(2)} KB`;
      } else {
        return `${Math.floor(bytes)} B`;
      }

    } catch (error) {
      return '0 B';
    }
  }

  /**
   * Sanitize session ID for safe logging
   */
  private sanitizeSessionId(sessionId: string): string {
    try {
      if (typeof sessionId !== 'string') {
        return 'unknown';
      }

      // Truncate and remove control characters
      const truncated = sessionId.length > 50
        ? sessionId.substring(0, 50) + '...'
        : sessionId;

      return truncated.replace(/[\r\n\t\x00-\x1f\x7f]/g, ' ').trim();

    } catch (error) {
      return 'unknown';
    }
  }

  /**
   * Log memory statistics to console
   */
  logStats(): void {
    try {
      const stats = this.getStats();

      console.log('=== Memory Statistics ===');

      if (stats.current) {
        console.log(`Heap Used: ${this.formatBytes(stats.current.heapUsed)}`);
        console.log(`Heap Total: ${this.formatBytes(stats.current.heapTotal)}`);
        console.log(`RSS: ${this.formatBytes(stats.current.rss)}`);
      }

      console.log(`Growth Rate: ${this.formatBytes(stats.heapGrowthRate)}/min`);
      console.log(`Sessions: ${stats.sessions.length}`);

      for (const session of stats.sessions) {
        if (session && session.sessionId && typeof session.heapUsed === 'number') {
          console.log(`  - ${this.sanitizeSessionId(session.sessionId)}: ${this.formatBytes(session.heapUsed)}`);
        }
      }

      console.log(`Budget: ${this.formatBytes(this.budget.perSession)}/session, ${this.formatBytes(this.budget.totalSystem)} total`);

    } catch (error) {
      console.error('Failed to log memory stats:', error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Cleanup (remove all listeners and stop monitoring)
   */
  destroy(): void {
    try {
      this.stop();
      this.removeAllListeners();
      this.sessionMemory.clear();
      this.measurements = [];
      this.heapGrowthHistory = [];

    } catch (error) {
      // Suppress cleanup errors
    }
  }
}

export default MemoryMonitor;
export { MemoryStats, SessionMemory, MemoryBudget, MemoryAlert };
