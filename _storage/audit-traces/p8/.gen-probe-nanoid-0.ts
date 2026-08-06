
import * as __m from 'nanoid'
const __ns: any = __m as any
const z: any = __ns.z ?? __ns.default ?? __ns
const { nanoid } = __ns as any

const uniqueId = nanoid();
console.log(uniqueId);

for (const S of [uniqueId] as any[]) {
  try { if (typeof S === 'string' && S.length > 5) console.log('__OK__') } catch {}
}
