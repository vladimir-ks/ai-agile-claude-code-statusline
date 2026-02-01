import RuntimeStateStore from './lib/runtime-state-store';

const store = new RuntimeStateStore();
const state = store.read();

// Just re-write to trigger YAML regeneration with quick-lookup
(store as any).write(state);

console.log('YAML regenerated with quick-lookup section');
