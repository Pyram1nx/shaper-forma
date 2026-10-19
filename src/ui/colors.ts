// Colours for canvas and WebGL drawing (Viewer3D, Paper Scan). They mirror the
// values in src/styles/tokens.css; keep the two in step when a token changes.
export const COLORS = {
  white: '#fdfdfe',
  gray50: '#f6f7f9',
  gray200: '#dfe1e7',
  gray400: '#8e929f',
  blue050: '#2c65ff',
  cutGreen: '#1be09e',
  // Not in tokens.css: 3D-only greys.
  meshGrey: '#9aa0ab',
  gridMinor: '#e9ebf0',
  ground: '#c9ced8',
  wood: '#d9b17a',
  cutLine: '#5a3a1e',
} as const

/** '#rrggbb' to the 0xRRGGBB number that three.js takes. */
export const hexNum = (c: string): number => parseInt(c.slice(1), 16)
