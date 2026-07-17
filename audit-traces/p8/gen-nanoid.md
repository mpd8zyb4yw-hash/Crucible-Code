nanoid@6.0.0/index.d.ts
/**
 * A tiny, secure, URL-friendly, unique string ID generator for JavaScript
 * with hardware random generator.
 *
 * ```js
 * import { nanoid } from 'nanoid'
 * model.id = nanoid() //=> "V1StGXR8_Z5jdHi6B-myT"
 * ```
 *
 * @module
 */

/**
 * Generate secure URL-friendly unique ID.
 *
 * By default, the ID will have 21 symbols to have a collision probability
 * similar to UUID v4.
 *
 * ```js
 * import { nanoid } from 'nanoid'
 * model.id = nanoid() //=> "Uakgb_J5m9g-0JDMbcJqL"
 * ```
 *
 * @param size Size of the ID. The default size is 21.
 * @typeparam Type The ID type to replace `string` with some opaque type.
 * @returns A random string.
 */
export function nanoid<Type extends string>(size?: number): Type

/**
 * Generate secure unique ID with custom alphabet … noid = customAlphabet('0123456789абвгдеё', 5)
 * nanoid() //=> "8ё56а"
 * ```
 */
export function customAlphabet<Type extends string>(
  alphabet: string,
  defaultSize?: number
): (size?: number) => Type

/**
 * Generate unique ID with custom random generator and alphabet.
 *
 * Alphabet must contain 256 symbols or less. Otherwise, the generator
 * will not be secure.
 *
 * ```js
 * import { cust

---
Sources:
[S1] nanoid@6.0.0 — published type definitions (authoritative API surface) — https://www.npmjs.com/package/nanoid/v/6.0.0