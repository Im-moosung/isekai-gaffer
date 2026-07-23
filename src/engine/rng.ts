// src/engine/rng.ts
export interface Rng {
  next(): number
  int(min: number, max: number): number
  chance(p: number): boolean
  pick<T>(arr: T[]): T
  weighted<T>(items: { item: T; w: number }[]): T
}

export function createRng(seed: number): Rng {
  let s = seed >>> 0
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    chance: (p) => next() < p,
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    weighted: (items) => {
      const total = items.reduce((s2, i) => s2 + i.w, 0)
      if (total <= 0) throw new Error('weighted: total weight must be > 0')
      let roll = next() * total
      for (const { item, w } of items) { roll -= w; if (roll < 0 && w > 0) return item }
      return items.filter(i => i.w > 0).at(-1)!.item
    },
  }
}
