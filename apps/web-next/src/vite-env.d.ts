/// <reference types="vite/client" />

// Compile-time constant injected by vite.config.ts / vitest.config.ts (both
// MUST agree — see the ee-resolve.ts header for why these two configs
// diverging is a recurring failure mode here).
declare const __APP_VERSION__: string;
