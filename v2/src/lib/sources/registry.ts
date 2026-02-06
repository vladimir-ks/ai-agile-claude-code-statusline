/**
 * DataSourceRegistry - Central registry for all data sources
 *
 * Static class (project convention). Sources register at startup.
 * The UnifiedDataBroker queries the registry to orchestrate gather cycles.
 *
 * Usage:
 *   DataSourceRegistry.register(billingOAuthSource);
 *   DataSourceRegistry.register(gitSource);
 *   ...
 *   const tier3 = DataSourceRegistry.getByTier(3);
 */

import type { DataSourceDescriptor, DataSourceTier } from './types';

const sources = new Map<string, DataSourceDescriptor>();

export class DataSourceRegistry {
  /**
   * Register a data source. Overwrites if same ID already registered.
   */
  static register<T>(descriptor: DataSourceDescriptor<T>): void {
    sources.set(descriptor.id, descriptor);
  }

  /**
   * Get a source by ID. Returns undefined if not registered.
   */
  static get(id: string): DataSourceDescriptor | undefined {
    return sources.get(id);
  }

  /**
   * Get all registered sources.
   */
  static getAll(): DataSourceDescriptor[] {
    return Array.from(sources.values());
  }

  /**
   * Get sources by tier.
   */
  static getByTier(tier: DataSourceTier): DataSourceDescriptor[] {
    return Array.from(sources.values()).filter(s => s.tier === tier);
  }

  /**
   * Get sources that depend on a given source ID.
   */
  static getDependents(sourceId: string): DataSourceDescriptor[] {
    return Array.from(sources.values()).filter(
      s => s.dependencies?.includes(sourceId)
    );
  }

  /**
   * Get count of registered sources.
   */
  static size(): number {
    return sources.size;
  }

  /**
   * Check if a source is registered.
   */
  static has(id: string): boolean {
    return sources.has(id);
  }

  /**
   * Remove a source (mainly for testing).
   */
  static remove(id: string): boolean {
    return sources.delete(id);
  }

  /**
   * Clear all registered sources (for testing).
   */
  static clear(): void {
    sources.clear();
  }
}

export default DataSourceRegistry;
