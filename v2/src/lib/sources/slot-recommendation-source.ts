/**
 * Slot Recommendation Source — Tier 3 (global)
 *
 * Checks if current slot should switch to a better one.
 * Priority: QuotaBrokerClient → SlotRecommendationReader.
 * Registers/removes notification via NotificationManager.
 */

import type { DataSourceDescriptor, GatherContext } from './types';
import type { SessionHealth } from '../../types/session-health';
import { SessionLockManager } from '../session-lock-manager';
import { QuotaBrokerClient } from '../quota-broker-client';
import { SlotRecommendationReader } from '../slot-recommendation-reader';
import { NotificationManager } from '../notification-manager';

export interface SlotRecommendationData {
  currentSlot: string | null;
  switchMessage: string | null;
  checkedAt: number;
}

export const slotRecommendationSource: DataSourceDescriptor<SlotRecommendationData> = {
  id: 'slot_recommendation',
  tier: 3,
  freshnessCategory: 'notifications', // Same lifecycle as notifications
  timeoutMs: 500,

  async fetch(ctx: GatherContext): Promise<SlotRecommendationData> {
    const lock = SessionLockManager.read(ctx.sessionId);
    if (!lock?.slotId) {
      return { currentSlot: null, switchMessage: null, checkedAt: Date.now() };
    }

    let switchMsg: string | null = null;
    if (QuotaBrokerClient.isAvailable()) {
      switchMsg = QuotaBrokerClient.getSwitchMessage(lock.slotId);
    } else {
      switchMsg = SlotRecommendationReader.getSwitchMessage(lock.slotId);
    }

    return {
      currentSlot: lock.slotId,
      switchMessage: switchMsg,
      checkedAt: Date.now(),
    };
  },

  merge(_target: SessionHealth, data: SlotRecommendationData): void {
    // Updates notification system, not SessionHealth directly
    if (data.switchMessage) {
      NotificationManager.register('slot_switch', data.switchMessage, 6);
    } else if (data.currentSlot) {
      NotificationManager.remove('slot_switch');
    }
  },
};

export default slotRecommendationSource;
