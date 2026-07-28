// Compile-time proof that the client's mirrored protocol types still match the server's (cont.118).
//
// SurfaceRenderer.tsx deliberately re-declares `Entity`, `BoundAffordance` and `ViewSpec` instead
// of importing them, because it ships in the browser bundle. That buys bundle hygiene and costs a
// guarantee: nothing stops `viewDerivation.ts` from gaining a field, or changing `layout`, while
// the renderer keeps compiling against a stale shape. The failure mode is silent — the server
// sends a view the renderer has no branch for, and the surface renders empty or drops a column.
// `__surface_bench.ts` cannot catch it either: it only ever sees the SERVER's types.
//
// This file is the missing half. The imports are TYPE-ONLY, so `verbatimModuleSyntax` erases them
// entirely at build time and no engine code reaches the browser — verified by the fact that the
// whole transitive closure here is `viewDerivation -> entities`, and `entities.ts` imports nothing
// at all (it says so at the top of the file, and that is load-bearing, not decoration).
//
// If this file fails to compile, the two declarations have DRIFTED. Fix the mirror in
// SurfaceRenderer.tsx to match the engine — never the other way round; the engine is the source.
import type { ViewSpec as ServerViewSpec } from '../CrucibleEngine/tools/viewDerivation'
import type { Entity as ServerEntity, BoundAffordance as ServerAffordance } from '../CrucibleEngine/tools/entities'
import type { ViewSpec as ClientViewSpec, Entity as ClientEntity, BoundAffordance as ClientAffordance } from './SurfaceRenderer'

/** `true` only when A and B are mutually assignable — one-way `extends` would let the client
 *  silently narrow (drop a field) or widen (accept a layout the renderer has no branch for). */
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never

/**
 * Mutual assignability alone is NOT sufficient, and this was measured rather than assumed.
 * Adding `drifted?: number` to the client's ViewSpec keeps both directions assignable — an extra
 * OPTIONAL property breaks neither `extends` — so the shape check passes while the declarations
 * have genuinely diverged. Comparing the key sets is what closes that hole.
 *
 * Verified by injecting each drift and re-running `tsc -p tsconfig.app.json`:
 *   client drops a required field (`sources`)      -> 3 errors   caught by Mutual
 *   field type changes (string[] -> number[])      -> 1 error    caught by Mutual
 *   `Layout` union loses a member (`map`)          -> 2 errors   caught by Mutual
 *   client adds an optional field                  -> 0 errors   caught only by Keys
 */
type Keys<A, B> = [keyof A] extends [keyof B] ? ([keyof B] extends [keyof A] ? true : never) : never

// A `never` here is the drift. The error points at whichever of the three shapes diverged.
export const VIEWSPEC_MATCHES: Mutual<ClientViewSpec, ServerViewSpec> = true
export const ENTITY_MATCHES: Mutual<ClientEntity, ServerEntity> = true
export const AFFORDANCE_MATCHES: Mutual<ClientAffordance, ServerAffordance> = true

export const VIEWSPEC_KEYS: Keys<ClientViewSpec, ServerViewSpec> = true
export const ENTITY_KEYS: Keys<ClientEntity, ServerEntity> = true
export const AFFORDANCE_KEYS: Keys<ClientAffordance, ServerAffordance> = true
