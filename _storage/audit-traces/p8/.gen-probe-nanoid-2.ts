
import * as __m from 'nanoid'
const __ns: any = __m as any
const z: any = __ns.z ?? __ns.default ?? __ns
const nanoid: any = __ns.nanoid ?? __ns.default
 */
function customAlphabet<Type extends string>(
  alphabet: string,
  defaultSize?: number
): (size?: number) => Type

/**
 * Generate unique ID with custom random generator and alphabet.
 *
 * Alphabet must contain 256 symbols or less. Otherwise, the generator
 * will not be secure.
 *
 * 
for (const S of [customAlphabet] as any[]) {
  try { if (typeof S === 'string' && S.length > 5) console.log('__OK__') } catch {}
}
