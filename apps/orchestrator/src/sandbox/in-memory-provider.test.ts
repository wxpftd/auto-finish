import { runProviderContract } from './contract.js';
import { InMemoryProvider } from './in-memory-provider.js';

runProviderContract('InMemoryProvider', () => new InMemoryProvider());
