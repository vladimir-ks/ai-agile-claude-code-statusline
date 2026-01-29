#!/usr/bin/env bun
/**
 * Statusline V2 - Main Entry Point (Complete Feature Parity with V1)
 *
 * Reads JSON from stdin, fetches data from all modules, renders statusline
 */

import DataBroker from './broker/data-broker';
import ContextModule from './modules/context-module';
import CostModule from './modules/cost-module';
import ModelModule from './modules/model-module';
import GitModule from './modules/git-module';
import TimeModule from './modules/time-module';
import DirectoryModule from './modules/directory-module';
import VersionModule from './modules/version-module';
import BudgetModule from './modules/budget-module';
import UsageModule from './modules/usage-module';
import CacheModule from './modules/cache-module';
import LastMessageModule from './modules/last-message-module';
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

    // Initialize all modules
    const directoryModule = new DirectoryModule();
    const contextModule = new ContextModule();
    const costModule = new CostModule();
    const modelModule = new ModelModule();
    const gitModule = new GitModule();
    const timeModule = new TimeModule();
    const versionModule = new VersionModule();
    const budgetModule = new BudgetModule();
    const usageModule = new UsageModule();
    const cacheModule = new CacheModule();
    const lastMessageModule = new LastMessageModule();

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

    // Register modules
    broker.registerModule(directoryModule);
    broker.registerModule(contextModule);
    broker.registerModule(costModule);
    broker.registerModule(modelModule);
    broker.registerModule(gitModule);
    broker.registerModule(timeModule);
    broker.registerModule(versionModule);
    broker.registerModule(budgetModule);
    broker.registerModule(usageModule);
    broker.registerModule(cacheModule);
    broker.registerModule(lastMessageModule);

    // Register session
    broker.registerSession(sessionId, process.env.HOME + '/.claude', null);

    // Fetch data from all modules in parallel
    const results = await Promise.allSettled([
      broker.getData('directory', sessionId).catch(handleModuleError('directory')),
      broker.getData('context', sessionId).catch(handleModuleError('context')),
      broker.getData('cost', sessionId).catch(handleModuleError('cost')),
      broker.getData('model', sessionId).catch(handleModuleError('model')),
      broker.getData('git', sessionId).catch(handleModuleError('git')),
      broker.getData('time', sessionId).catch(handleModuleError('time')),
      broker.getData('version', sessionId).catch(handleModuleError('version')),
      broker.getData('budget', sessionId).catch(handleModuleError('budget')),
      broker.getData('usage', sessionId).catch(handleModuleError('usage')),
      broker.getData('cache', sessionId).catch(handleModuleError('cache')),
      broker.getData('lastMessage', sessionId).catch(handleModuleError('lastMessage'))
    ]);

    // Extract data
    const [
      directoryData, contextData, costData, modelData, gitData, timeData,
      versionData, budgetData, usageData, cacheData, lastMessageData
    ] = results.map(getResultData);

    // Format each component
    const components = {
      directory: directoryData ? directoryModule.format(directoryData.data) : undefined,
      context: contextData ? contextModule.format(contextData.data) : undefined,
      cost: costData ? costModule.format(costData.data) : undefined,
      model: modelData ? modelModule.format(modelData.data) : undefined,
      git: gitData ? gitModule.format(gitData.data) : undefined,
      time: timeData ? timeModule.format(timeData.data) : undefined,
      version: versionData ? versionModule.format(versionData.data) : undefined,
      budget: budgetData ? budgetModule.format(budgetData.data) : undefined,
      usage: usageData ? usageModule.format(usageData.data) : undefined,
      cache: cacheData ? cacheModule.format(cacheData.data) : undefined,
      lastMessage: lastMessageData ? lastMessageModule.format(lastMessageData.data) : undefined
    };

    // Render statusline
    const renderer = new StatuslineRenderer({ useColors: true });
    const output = renderer.render(components);

    // Output to stdout
    if (output) {
      console.log(output);
    }

    // Cleanup
    await broker.shutdown();

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
