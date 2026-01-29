#!/usr/bin/env bun
/**
 * Statusline V2 - Main Entry Point
 *
 * Reads JSON from stdin, fetches data from all modules, renders statusline
 */

import DataBroker from './broker/data-broker';
import ContextModule from './modules/context-module';
import CostModule from './modules/cost-module';
import ModelModule from './modules/model-module';
import GitModule from './modules/git-module';
import TimeModule from './modules/time-module';
import StatuslineRenderer from './renderer/statusline-renderer';

async function main() {
  try {
    // Read JSON from stdin
    const stdin = await Bun.stdin.text();
    const sessionId = generateSessionId();

    // Initialize broker
    const broker = new DataBroker({
      maxCacheSize: 1000,
      evictionPolicy: 'LRU',
      sessionTimeoutMs: 3600000  // 1 hour
    });

    // Initialize modules
    const contextModule = new ContextModule();
    const costModule = new CostModule();
    const modelModule = new ModelModule();
    const gitModule = new GitModule();
    const timeModule = new TimeModule();

    // Set JSON input for modules that need it
    contextModule.setJsonInput(stdin);
    modelModule.setJsonInput(stdin);

    // Register modules
    broker.registerModule(contextModule);
    broker.registerModule(costModule);
    broker.registerModule(modelModule);
    broker.registerModule(gitModule);
    broker.registerModule(timeModule);

    // Register session
    broker.registerSession(sessionId, process.env.HOME + '/.claude', null);

    // Fetch data from all modules in parallel
    const [contextResult, costResult, modelResult, gitResult, timeResult] = await Promise.allSettled([
      broker.getData('context', sessionId).catch(handleModuleError('context')),
      broker.getData('cost', sessionId).catch(handleModuleError('cost')),
      broker.getData('model', sessionId).catch(handleModuleError('model')),
      broker.getData('git', sessionId).catch(handleModuleError('git')),
      broker.getData('time', sessionId).catch(handleModuleError('time'))
    ]);

    // Extract data
    const contextData = getResultData(contextResult);
    const costData = getResultData(costResult);
    const modelData = getResultData(modelResult);
    const gitData = getResultData(gitResult);
    const timeData = getResultData(timeResult);

    // Format each component
    const components = {
      context: contextData ? contextModule.format(contextData.data) : undefined,
      cost: costData ? costModule.format(costData.data) : undefined,
      model: modelData ? modelModule.format(modelData.data) : undefined,
      git: gitData ? gitModule.format(gitData.data) : undefined,
      time: timeData ? timeModule.format(timeData.data) : undefined
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
