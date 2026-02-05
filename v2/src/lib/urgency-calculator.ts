/**
 * Urgency Calculator - Session urgency scoring for swap decisions
 *
 * Computes a 0-100 urgency score based on:
 * - Weekly quota usage (60% weight) — primary driver for swap
 * - Daily budget usage (30% weight) — secondary signal
 * - Burn rate factor (10% weight) — velocity indicator
 *
 * Score thresholds:
 *   > 80 → swap recommended
 *   > 95 → swap urgent
 *
 * Used by health-publisher to communicate session urgency
 * to the cloud_configs/hot-swap system.
 */

export interface UrgencyInput {
  weeklyPercentUsed: number;     // 0-100
  dailyPercentUsed: number;      // 0-100
  burnRatePerHour: number;       // USD/hour
  budgetRemaining: number;       // minutes remaining
}

export interface UrgencyResult {
  score: number;                  // 0-100
  level: 'low' | 'medium' | 'high' | 'urgent';
  recommendation: 'none' | 'swap_recommended' | 'swap_urgent';
  factors: {
    weeklyContribution: number;
    dailyContribution: number;
    burnRateContribution: number;
  };
}

// Weights
const WEEKLY_WEIGHT = 0.6;
const DAILY_WEIGHT = 0.3;
const BURN_RATE_WEIGHT = 0.1;

// Burn rate normalization: $20/hour = 100% burn factor
const BURN_RATE_CEILING = 20;

export class UrgencyCalculator {

  /**
   * Calculate urgency score for a session.
   */
  static calculate(input: UrgencyInput): UrgencyResult {
    const weekly = Math.min(100, Math.max(0, input.weeklyPercentUsed || 0));
    const daily = Math.min(100, Math.max(0, input.dailyPercentUsed || 0));

    // Burn rate factor: normalize to 0-100 based on ceiling
    const burnRaw = Math.min(100, Math.max(0,
      ((input.burnRatePerHour || 0) / BURN_RATE_CEILING) * 100
    ));

    // Bonus for very low remaining budget (accelerator)
    // If <30 minutes remaining, add up to 10 points
    let lowBudgetBonus = 0;
    if (input.budgetRemaining !== undefined && input.budgetRemaining < 30) {
      lowBudgetBonus = Math.round((1 - input.budgetRemaining / 30) * 10);
    }

    const weeklyContribution = weekly * WEEKLY_WEIGHT;
    const dailyContribution = daily * DAILY_WEIGHT;
    const burnRateContribution = burnRaw * BURN_RATE_WEIGHT;

    const rawScore = weeklyContribution + dailyContribution + burnRateContribution + lowBudgetBonus;
    const score = Math.min(100, Math.round(rawScore));

    return {
      score,
      level: this.scoreToLevel(score),
      recommendation: this.scoreToRecommendation(score),
      factors: {
        weeklyContribution: Math.round(weeklyContribution * 10) / 10,
        dailyContribution: Math.round(dailyContribution * 10) / 10,
        burnRateContribution: Math.round(burnRateContribution * 10) / 10,
      },
    };
  }

  private static scoreToLevel(score: number): UrgencyResult['level'] {
    if (score >= 95) return 'urgent';
    if (score >= 80) return 'high';
    if (score >= 50) return 'medium';
    return 'low';
  }

  private static scoreToRecommendation(score: number): UrgencyResult['recommendation'] {
    if (score >= 95) return 'swap_urgent';
    if (score >= 80) return 'swap_recommended';
    return 'none';
  }
}

export default UrgencyCalculator;
