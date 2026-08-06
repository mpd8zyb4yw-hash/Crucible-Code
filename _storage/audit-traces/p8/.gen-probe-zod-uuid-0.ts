
import * as __m from 'zod'
const __ns: any = __m as any
const z: any = __ns.z ?? __ns.default ?? __ns
const { guid } = __ns as any

const uuidString = guid();
console.log(uuidString);

for (const S of [uuidString] as any[]) {
  try { if (S.safeParse('550e8400-e29b-41d4-a716-446655440000').success && !S.safeParse('x').success) console.log('__OK__') } catch {}
}
