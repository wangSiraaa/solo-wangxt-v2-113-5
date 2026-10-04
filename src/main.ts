import App from './App.svelte';
import { installDebugHooks } from './lib/debug';

const app = new App({
  target: document.getElementById('app')!
});

if (import.meta.env.DEV) installDebugHooks();

export default app;
