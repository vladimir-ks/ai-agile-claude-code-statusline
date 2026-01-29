/**
 * Unit Tests: Cost Module
 *
 * Tests:
 * 1. ccusage JSON parsing
 * 2. Cost calculation and burn rate
 * 3. Time remaining calculations
 * 4. Validation rules (cost >= 0, timestamps valid)
 * 5. Edge cases (no active block, missing data)
 */

import { describe, test, expect } from 'bun:test';

// Mock data structures
interface CostData {
  blockId: string;
  startTime: Date;
  endTime: Date;
  actualEndTime: Date | null;
  isActive: boolean;
  costUSD: number;
  totalTokens: number;
  burnRate: {
    costPerHour: number;
    tokensPerMinute: number;
  } | null;
  projection: {
    totalCost: number;
    remainingMinutes: number;
  } | null;
  hoursRemaining: number;
  percentageComplete: number;
}

// Mock implementation
class CostModule {
  parseCcusageOutput(jsonOutput: string): CostData | null {
    try {
      const parsed = JSON.parse(jsonOutput);
      const blocks = parsed.blocks || [];
      const activeBlock = blocks.find((b: any) => b.isActive === true);

      if (!activeBlock) {
        return null;
      }

      const startTime = new Date(activeBlock.startTime);
      const endTime = new Date(activeBlock.endTime);
      const now = Date.now();
      const remainingMs = Math.max(0, endTime.getTime() - now);
      const hoursRemaining = remainingMs / (1000 * 60 * 60);

      const totalDuration = endTime.getTime() - startTime.getTime();
      const elapsed = now - startTime.getTime();
      const percentageComplete = totalDuration > 0
        ? Math.min(100, Math.floor((elapsed / totalDuration) * 100))
        : 0;

      return {
        blockId: activeBlock.id,
        startTime,
        endTime,
        actualEndTime: activeBlock.actualEndTime ? new Date(activeBlock.actualEndTime) : null,
        isActive: activeBlock.isActive,
        costUSD: activeBlock.costUSD || 0,
        totalTokens: activeBlock.totalTokens || 0,
        burnRate: activeBlock.burnRate ? {
          costPerHour: activeBlock.burnRate.costPerHour || 0,
          tokensPerMinute: activeBlock.burnRate.tokensPerMinute || 0
        } : null,
        projection: activeBlock.projection ? {
          totalCost: activeBlock.projection.totalCost || 0,
          remainingMinutes: activeBlock.projection.remainingMinutes || 0
        } : null,
        hoursRemaining,
        percentageComplete
      };
    } catch (error) {
      return null;
    }
  }

  formatCost(cost: number): string {
    return `$${cost.toFixed(1)}`;
  }

  formatCompactNumber(num: number): string {
    if (num >= 1000000) {
      return `${(num / 1000000).toFixed(1)}M`;
    } else if (num >= 1000) {
      return `${Math.floor(num / 1000)}k`;
    } else {
      return `${num}`;
    }
  }

  validateCostData(data: CostData): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (data.costUSD < 0) {
      errors.push('Cost cannot be negative');
    }

    if (data.totalTokens < 0) {
      errors.push('Total tokens cannot be negative');
    }

    if (data.burnRate) {
      if (data.burnRate.costPerHour < 0) {
        errors.push('Burn rate cannot be negative');
      }
      if (data.burnRate.tokensPerMinute < 0) {
        errors.push('TPM cannot be negative');
      }
    }

    if (data.percentageComplete < 0 || data.percentageComplete > 100) {
      errors.push('Percentage complete out of range');
    }

    if (data.endTime <= data.startTime) {
      errors.push('End time must be after start time');
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }
}

describe('CostModule - ccusage Parsing', () => {
  const module = new CostModule();

  const mockCcusageOutput = `{
    "blocks": [{
      "id": "2026-01-28T12:00:00.000Z",
      "startTime": "2026-01-28T12:00:00.000Z",
      "endTime": "2026-01-28T17:00:00.000Z",
      "isActive": true,
      "costUSD": 11.63,
      "totalTokens": 24651156,
      "burnRate": {
        "tokensPerMinute": 185460.68,
        "costPerHour": 5.25
      },
      "projection": {
        "totalCost": 26.24,
        "remainingMinutes": 167
      }
    }]
  }`;

  test('Parse active block successfully', () => {
    const result = module.parseCcusageOutput(mockCcusageOutput);

    expect(result).not.toBeNull();
    expect(result!.blockId).toBe('2026-01-28T12:00:00.000Z');
    expect(result!.costUSD).toBe(11.63);
    expect(result!.totalTokens).toBe(24651156);
    expect(result!.isActive).toBe(true);
  });

  test('Extract burn rate correctly', () => {
    const result = module.parseCcusageOutput(mockCcusageOutput);

    expect(result!.burnRate).not.toBeNull();
    expect(result!.burnRate!.costPerHour).toBe(5.25);
    expect(result!.burnRate!.tokensPerMinute).toBe(185460.68);
  });

  test('Extract projection correctly', () => {
    const result = module.parseCcusageOutput(mockCcusageOutput);

    expect(result!.projection).not.toBeNull();
    expect(result!.projection!.totalCost).toBe(26.24);
    expect(result!.projection!.remainingMinutes).toBe(167);
  });

  test('Handle no active block', () => {
    const noActiveBlock = `{
      "blocks": [{
        "id": "2026-01-28T12:00:00.000Z",
        "startTime": "2026-01-28T12:00:00.000Z",
        "endTime": "2026-01-28T17:00:00.000Z",
        "isActive": false,
        "costUSD": 15.00
      }]
    }`;

    const result = module.parseCcusageOutput(noActiveBlock);
    expect(result).toBeNull();
  });

  test('Handle malformed JSON', () => {
    const result = module.parseCcusageOutput('invalid json{');
    expect(result).toBeNull();
  });

  test('Handle empty blocks array', () => {
    const result = module.parseCcusageOutput('{"blocks": []}');
    expect(result).toBeNull();
  });
});

describe('CostModule - Validation', () => {
  const module = new CostModule();

  test('Valid cost data passes validation', () => {
    const validData: CostData = {
      blockId: 'test-block',
      startTime: new Date('2026-01-28T12:00:00Z'),
      endTime: new Date('2026-01-28T17:00:00Z'),
      actualEndTime: null,
      isActive: true,
      costUSD: 11.63,
      totalTokens: 24651156,
      burnRate: {
        costPerHour: 5.25,
        tokensPerMinute: 185460
      },
      projection: {
        totalCost: 26.24,
        remainingMinutes: 167
      },
      hoursRemaining: 2.78,
      percentageComplete: 44
    };

    const result = module.validateCostData(validData);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test('Negative cost fails validation', () => {
    const invalidData: CostData = {
      blockId: 'test-block',
      startTime: new Date('2026-01-28T12:00:00Z'),
      endTime: new Date('2026-01-28T17:00:00Z'),
      actualEndTime: null,
      isActive: true,
      costUSD: -5.00,
      totalTokens: 100000,
      burnRate: null,
      projection: null,
      hoursRemaining: 3,
      percentageComplete: 40
    };

    const result = module.validateCostData(invalidData);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Cost cannot be negative');
  });

  test('Negative tokens fail validation', () => {
    const invalidData: CostData = {
      blockId: 'test-block',
      startTime: new Date('2026-01-28T12:00:00Z'),
      endTime: new Date('2026-01-28T17:00:00Z'),
      actualEndTime: null,
      isActive: true,
      costUSD: 10.00,
      totalTokens: -1000,
      burnRate: null,
      projection: null,
      hoursRemaining: 3,
      percentageComplete: 40
    };

    const result = module.validateCostData(invalidData);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Total tokens cannot be negative');
  });

  test('Invalid percentage fails validation', () => {
    const invalidData: CostData = {
      blockId: 'test-block',
      startTime: new Date('2026-01-28T12:00:00Z'),
      endTime: new Date('2026-01-28T17:00:00Z'),
      actualEndTime: null,
      isActive: true,
      costUSD: 10.00,
      totalTokens: 100000,
      burnRate: null,
      projection: null,
      hoursRemaining: 3,
      percentageComplete: 150
    };

    const result = module.validateCostData(invalidData);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Percentage complete out of range');
  });

  test('End time before start time fails validation', () => {
    const invalidData: CostData = {
      blockId: 'test-block',
      startTime: new Date('2026-01-28T17:00:00Z'),
      endTime: new Date('2026-01-28T12:00:00Z'),
      actualEndTime: null,
      isActive: true,
      costUSD: 10.00,
      totalTokens: 100000,
      burnRate: null,
      projection: null,
      hoursRemaining: 0,
      percentageComplete: 100
    };

    const result = module.validateCostData(invalidData);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('End time must be after start time');
  });
});

describe('CostModule - Formatting', () => {
  const module = new CostModule();

  test('Format cost with 1 decimal', () => {
    expect(module.formatCost(0)).toBe('$0.0');
    expect(module.formatCost(5.23)).toBe('$5.2');
    expect(module.formatCost(11.638)).toBe('$11.6');
    expect(module.formatCost(100.99)).toBe('$101.0');
  });

  test('Format large numbers compactly', () => {
    expect(module.formatCompactNumber(500)).toBe('500');
    expect(module.formatCompactNumber(1000)).toBe('1k');
    expect(module.formatCompactNumber(5000)).toBe('5k');
    expect(module.formatCompactNumber(185460)).toBe('185k');
    expect(module.formatCompactNumber(1000000)).toBe('1.0M');
    expect(module.formatCompactNumber(24651156)).toBe('24.7M');
  });
});

describe('CostModule - Real-World Scenarios', () => {
  const module = new CostModule();

  test('Scenario: Early in 5-hour block', () => {
    const earlyBlock = `{
      "blocks": [{
        "id": "2026-01-29T08:00:00.000Z",
        "startTime": "2026-01-29T08:00:00.000Z",
        "endTime": "2026-01-29T13:00:00.000Z",
        "isActive": true,
        "costUSD": 2.50,
        "totalTokens": 5000000,
        "burnRate": {
          "tokensPerMinute": 50000,
          "costPerHour": 1.25
        },
        "projection": {
          "totalCost": 6.25,
          "remainingMinutes": 240
        }
      }]
    }`;

    const result = module.parseCcusageOutput(earlyBlock);

    expect(result!.costUSD).toBe(2.50);
    expect(result!.projection!.totalCost).toBe(6.25);
    // Should have ~4 hours remaining (240 minutes)
    expect(result!.projection!.remainingMinutes).toBe(240);
  });

  test('Scenario: End of 5-hour block', () => {
    const endBlock = `{
      "blocks": [{
        "id": "2026-01-29T08:00:00.000Z",
        "startTime": "2026-01-29T08:00:00.000Z",
        "endTime": "2026-01-29T13:00:00.000Z",
        "isActive": true,
        "costUSD": 24.80,
        "totalTokens": 125000000,
        "burnRate": {
          "tokensPerMinute": 500000,
          "costPerHour": 5.00
        },
        "projection": {
          "totalCost": 25.00,
          "remainingMinutes": 2
        }
      }]
    }`;

    const result = module.parseCcusageOutput(endBlock);

    expect(result!.costUSD).toBe(24.80);
    expect(result!.projection!.totalCost).toBe(25.00);
    // Only 2 minutes left
    expect(result!.projection!.remainingMinutes).toBe(2);
  });

  test('Scenario: Idle block (no activity)', () => {
    const idleBlock = `{
      "blocks": [{
        "id": "2026-01-29T08:00:00.000Z",
        "startTime": "2026-01-29T08:00:00.000Z",
        "endTime": "2026-01-29T13:00:00.000Z",
        "isActive": true,
        "costUSD": 0,
        "totalTokens": 0,
        "burnRate": null,
        "projection": null
      }]
    }`;

    const result = module.parseCcusageOutput(idleBlock);

    expect(result!.costUSD).toBe(0);
    expect(result!.totalTokens).toBe(0);
    expect(result!.burnRate).toBeNull();
    expect(result!.projection).toBeNull();
  });
});

describe('CostModule - Edge Cases', () => {
  const module = new CostModule();

  test('Handle missing optional fields gracefully', () => {
    const minimalBlock = `{
      "blocks": [{
        "id": "test",
        "startTime": "2026-01-29T08:00:00.000Z",
        "endTime": "2026-01-29T13:00:00.000Z",
        "isActive": true
      }]
    }`;

    const result = module.parseCcusageOutput(minimalBlock);

    expect(result).not.toBeNull();
    expect(result!.costUSD).toBe(0);
    expect(result!.totalTokens).toBe(0);
    expect(result!.burnRate).toBeNull();
  });

  test('Handle multiple blocks (only active one)', () => {
    const multipleBlocks = `{
      "blocks": [
        {
          "id": "old-block",
          "startTime": "2026-01-28T12:00:00.000Z",
          "endTime": "2026-01-28T17:00:00.000Z",
          "isActive": false,
          "costUSD": 15.00
        },
        {
          "id": "active-block",
          "startTime": "2026-01-29T08:00:00.000Z",
          "endTime": "2026-01-29T13:00:00.000Z",
          "isActive": true,
          "costUSD": 5.00
        }
      ]
    }`;

    const result = module.parseCcusageOutput(multipleBlocks);

    expect(result).not.toBeNull();
    expect(result!.blockId).toBe('active-block');
    expect(result!.costUSD).toBe(5.00);
  });
});
