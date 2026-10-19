/** True when running inside the Tauri desktop shell (Mac, Windows, Linux), false in a browser. */
export const isDesktop = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
