#!/usr/bin/env bun
/**
 * Statusline V2 - Main Entry Point (FIXED: Single ccusage call)
 *
 * CRITICAL FIX: Uses shared ccusage module to prevent 3 concurrent calls
 */

import DataBroker from './broker/data-broker';
import ContextModule from './modules/context-module';
import ModelModule from './modules/model-module';
import GitModule from './modules/git-module';
import TimeModule from './modules/time-module';
import DirectoryModule from './modules/directory-module';
import VersionModule from './modules/version-module';
import CacheModule from './modules/cache-module';
import LastMessageModule from './modules/last-message-module';

// CRITICAL: Single ccusage module + 3 wrappers (NO concurrent calls)
import CCUsageSharedModule from './modules/ccusage-shared-module';
import CostWrapperModule from './modules/cost-wrapper-module';
import BudgetWrapperModule from './modules/budget-wrapper-module';
import UsageWrapperModule from './modules/usage-wrapper-module';

import StatuslineRenderer from './renderer/statusline-renderer';

async function main() {
  try {
    // Read JSON from stdin
    const stdin = await Bun.stdin.text();
    const sessionId = generateSessionId();

    // Parse JSON to get transcript path
    let transcriptPath = '';
    try {
      const parsed = JSON.parse(stdin);
      transcriptPath = parsed.transcript_path || '';
    } catch {
      // JSON parse failed, continue without transcript
    }

    // Initialize broker
    const broker = new DataBroker({
      maxCacheSize: 1000,
      evictionPolicy: 'LRU',
      sessionTimeoutMs: 3600000  // 1 hour
    });

    // Initialize fast modules (no external calls)
    const directoryModule = new DirectoryModule();
    const contextModule = new ContextModule();
    const modelModule = new ModelModule();
    const gitModule = new GitModule();
    const timeModule = new TimeModule();
    const versionModule = new VersionModule();
    const cacheModule = new CacheModule();
    const lastMessageModule = new LastMessageModule();

    // Initialize ccusage module (SINGLE call for all three: cost, budget, usage)
    const ccusageModule = new CCUsageSharedModule();

    // Initialize wrapper modules (formatting only, no fetching)
    const costWrapper = new CostWrapperModule();
    const budgetWrapper = new BudgetWrapperModule();
    const usageWrapper = new UsageWrapperModule();

    // Set JSON input for modules that need it
    directoryModule.setJsonInput(stdin);
    contextModule.setJsonInput(stdin);
    modelModule.setJsonInput(stdin);
    versionModule.setJsonInput(stdin);
    cacheModule.setJsonInput(stdin);

    // Set transcript path for last message module
    if (transcriptPath) {
      lastMessageModule.setTranscriptPath(transcriptPath);
    }

    // Register modules (NOT the wrappers, they don't fetch)
    broker.registerModule(directoryModule);
    broker.registerModule(contextModule);
    broker.registerModule(modelModule);
    broker.registerModule(gitModule);
    broker.registerModule(timeModule);
    broker.registerModule(versionModule);
    broker.registerModule(cacheModule);
    broker.registerModule(lastMessageModule);
    broker.registerModule(ccusageModule);  // SINGLE ccusage module

    // Register session
    broker.registerSession(sessionId, process.env.HOME + '/.claude', null);

    // Fetch FAST modules first (no ccusage - it's slow)
    // ccusage will fetch in background, cached for future calls
    const fastModulePromises = [
      broker.getData('directory', sessionId).catch(handleModuleError('directory')),
      broker.getData('context', sessionId).catch(handleModuleError('context')),
      broker.getData('model', sessionId).catch(handleModuleError('model')),
      broker.getData('git', sessionId).catch(handleModuleError('git')),
      broker.getData('time', sessionId).catch(handleModuleError('time')),
      broker.getData('version', sessionId).catch(handleModuleError('version')),
      broker.getData('cache', sessionId).catch(handleModuleError('cache')),
      broker.getData('lastMessage', sessionId).catch(handleModuleError('lastMessage'))
    ];

    // Start ccusage fetch but DON'T wait for it (background fetch)
    const ccusagePromise = broker.getData('ccusage', sessionId).catch(handleModuleError('ccusage'));

    // Wait for fast modules only
    const results = await Promise.allSettled(fastModulePromises);

    // Extract data from fast modules
    const [
      directoryData, contextData, modelData, gitData, timeData,
      versionData, cacheData, lastMessageData
    ] = results.map(getResultData);

    // Try to get ccusage data if it's already resolved (from cache)
    // Don't wait for it - it fetches in background
    const ccusageResult = await Promise.race([
      ccusagePromise,
      new Promise(resolve => setTimeout(() => resolve(null), 100))  // 100ms timeout
    ]);
    const ccusageData = ccusageResult ? getResultData({ status: 'fulfilled', value: ccusageResult } as any) : null;

    // Format each component
    const components = {
      directory: directoryData ? directoryModule.format(directoryData.data) : undefined,
      context: contextData ? contextModule.format(contextData.data) : undefined,
      model: modelData ? modelModule.format(modelData.data) : undefined,
      git: gitData ? gitModule.format(gitData.data) : undefined,
      time: timeData ? timeModule.format(timeData.data) : undefined,
      version: versionData ? versionModule.format(versionData.data) : undefined,
      cache: cacheData ? cacheModule.format(cacheData.data) : undefined,
      lastMessage: lastMessageData ? lastMessageModule.format(lastMessageData.data) : undefined,

      // Use ccusage data for all three (cost, budget, usage)
      cost: ccusageData ? costWrapper.format(ccusageData.data) : undefined,
      budget: ccusageData ? budgetWrapper.format(ccusageData.data) : undefined,
      usage: ccusageData ? usageWrapper.format(ccusageData.data) : undefined
    };

    // Render statusline
    const renderer = new StatuslineRenderer({ useColors: true });
    const output = renderer.render(components);

    // Output to stdout (NO trailing newline - critical for CLI UI)
    if (output) {
      process.stdout.write(output);
    }

    // Cleanup (non-blocking)
    broker.shutdown().catch(() => {});  // Fire and forget

    // Force exit immediately after output
    process.exit(0);

  } catch (error) {
    // Fallback output on error
    console.error('⚠ V2 ERR');
    process.exit(1);
  }
}

function generateSessionId(): string {
  return `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

function handleModuleError(moduleName: string) {
  return (error: Error) => {
    // Silent error handling - return null to skip module
    return null;
  };
}

function getResultData(result: PromiseSettledResult<any>): any {
  if (result.status === 'fulfilled' && result.value) {
    return result.value;
  }
  return null;
}

// Run
main().catch((error) => {
  console.error('⚠ FATAL');
  process.exit(1);
});
