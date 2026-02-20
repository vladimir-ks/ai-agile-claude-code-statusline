/**
 * Rulesets — Registry
 */

import type { Rule, Category } from '../types';
import { SECRET_RULES } from './secrets';
import { PII_RULES } from './pii';

/** All built-in rules */
export const ALL_RULES: Rule[] = [...SECRET_RULES, ...PII_RULES];

/** Get rules by category */
export function getRulesByCategory(category: Category): Rule[] {
  return ALL_RULES.filter(r => r.category === category);
}

/** Get a single rule by ID */
export function getRuleById(id: string): Rule | undefined {
  return ALL_RULES.find(r => r.id === id);
}

export { SECRET_RULES } from './secrets';
export { PII_RULES } from './pii';
