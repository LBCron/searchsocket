export { searchsocketHandle } from "./sveltekit/handle";
export type { SearchSocketHandleOptions } from "./sveltekit/handle";
export { searchsocketVitePlugin } from "./sveltekit/plugin";
export type { SearchSocketAutoIndexOptions } from "./sveltekit/plugin";
/**
 * Browser code must import this from `searchsocket/scroll` instead: this entry
 * also carries the server handle and Vite plugin, and pulls Node builtins into
 * a client bundle. Kept here only for server-side and compatibility imports.
 */
export { searchsocketScrollToText } from "./sveltekit/scroll-to-text";
export type { AfterNavigateParam } from "./sveltekit/scroll-to-text";
