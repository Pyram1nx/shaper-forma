import { readFileSync, writeFileSync } from 'node:fs'
import { it } from 'vitest'
import { findPaperQuad } from '../../src/features/paper/detect'
import { decodeBmp } from './bmp'

it('findPaperQuad diag', () => {
  const img = decodeBmp(readFileSync(new URL('./samples/photo1.bmp', import.meta.url)).buffer as ArrayBuffer)
  const W = img.width, H = img.height
  const k = Math.min(1, 1000 / Math.max(W, H))
  const w = Math.max(2, Math.round(W * k)), h = Math.max(2, Math.round(H * k))
  const score = new Uint8Array(w * h)
  const step = 1 / k
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx0 = Math.floor(x * step), sx1 = Math.max(sx0 + 1, Math.floor((x + 1) * step))
    const sy0 = Math.floor(y * step), sy1 = Math.max(sy0 + 1, Math.floor((y + 1) * step))
    let r=0,g=0,b=0,c=0
    for (let sy=sy0;sy<sy1&&sy<H;sy++) for (let sx=sx0;sx<sx1&&sx<W;sx++){ const j=(sy*W+sx)*4; r+=img.data[j]; g+=img.data[j+1]; b+=img.data[j+2]; c++ }
    r/=c; g/=c; b/=c
    const v=((r*77+g*150+b*29)/256)-Math.max(0,Math.max(r,g,b)-Math.min(r,g,b)-20)
    score[y*w+x]=v<0?0:v>255?255:v
  }
  const diag = { log: [] as string[] }
  const r = findPaperQuad(score, w, h, diag)
  writeFileSync(new URL('./out/dbg4.txt', import.meta.url), [`result: ${JSON.stringify(r)}`, ...diag.log].join('\n'))
})
