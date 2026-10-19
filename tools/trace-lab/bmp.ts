// Minimal BMP decoder for the trace lab (24/32-bit uncompressed, bottom-up or top-down).
export interface RgbaImage {
  data: Uint8ClampedArray
  width: number
  height: number
}

export function decodeBmp(buf: ArrayBuffer): RgbaImage {
  const v = new DataView(buf)
  if (v.getUint16(0, false) !== 0x424d) throw new Error('not a BMP')
  const pixStart = v.getUint32(10, true)
  const w = v.getInt32(18, true)
  const hRaw = v.getInt32(22, true)
  const h = Math.abs(hRaw)
  const bottomUp = hRaw > 0
  const bpp = v.getUint16(28, true)
  if (bpp !== 24 && bpp !== 32) throw new Error(`unsupported bpp ${bpp}`)
  const bytesPerPx = bpp / 8
  const rowSize = Math.ceil((w * bytesPerPx) / 4) * 4
  const data = new Uint8ClampedArray(w * h * 4)
  const u8 = new Uint8Array(buf)
  for (let y = 0; y < h; y++) {
    const srcRow = pixStart + (bottomUp ? h - 1 - y : y) * rowSize
    for (let x = 0; x < w; x++) {
      const s = srcRow + x * bytesPerPx
      const d = (y * w + x) * 4
      data[d] = u8[s + 2]
      data[d + 1] = u8[s + 1]
      data[d + 2] = u8[s]
      data[d + 3] = 255
    }
  }
  return { data, width: w, height: h }
}
