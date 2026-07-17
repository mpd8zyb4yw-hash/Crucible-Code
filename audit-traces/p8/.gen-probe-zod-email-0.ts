
import * as __m from 'zod'
const __ns: any = __m as any

const { z } = __ns as any

const emailSchema = z.email();

for (const S of [emailSchema] as any[]) {
  try { if (S.safeParse('a@b.com').success && !S.safeParse('nope').success) console.log('__OK__') } catch {}
}
