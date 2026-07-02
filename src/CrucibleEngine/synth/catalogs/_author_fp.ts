import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url'
const HERE = path.dirname(fileURLToPath(import.meta.url))
interface Entry { id: string; filename: string; summary: string; defaultPath: string; exports: string[]; patterns: { re: string; weight: number }[]; impl: string; tests: { desc: string; call: string; want: string }[] }

const entries: Entry[] = [
  {
    id: 'option-monad', filename: 'optionMonad',
    summary: 'Option is a Maybe type with static some and none, plus map, getOrElse, isSome, and isNone.',
    defaultPath: 'src/optionMonad.ts', exports: ['Option'],
    patterns: [{ re: '\\bOption\\b', weight: 0.55 }, { re: 'maybe.*type|option.*monad|some.*none', weight: 0.35 }],
    impl: `export class Option<T> {
  private constructor(private val: T | null, private present: boolean) {}
  static some<T>(v: T): Option<T> { return new Option(v, true) }
  static none<T>(): Option<T> { return new Option<T>(null, false) }
  map<U>(fn: (v: T) => U): Option<U> { return this.present ? Option.some(fn(this.val as T)) : Option.none<U>() }
  getOrElse(def: T): T { return this.present ? (this.val as T) : def }
  isSome(): boolean { return this.present }
  isNone(): boolean { return !this.present }
}`,
    tests: [
      { desc: 'some getOrElse', call: 'Option.some(5).getOrElse(0)', want: '5' },
      { desc: 'none getOrElse', call: 'Option.none<number>().getOrElse(0)', want: '0' },
      { desc: 'map some', call: 'Option.some(3).map(x=>x*2).getOrElse(0)', want: '6' },
      { desc: 'map none', call: 'Option.none<number>().map(x=>x*2).getOrElse(-1)', want: '-1' },
      { desc: 'isSome', call: 'Option.some(1).isSome()', want: 'true' },
      { desc: 'isNone', call: 'Option.none().isNone()', want: 'true' },
      { desc: 'chained map', call: 'Option.some(2).map(x=>x+1).map(x=>x*10).getOrElse(0)', want: '30' },
    ],
  },
  {
    id: 'result-box', filename: 'resultBox',
    summary: 'ResultBox is an Ok/Err result type with static ok and err, plus map, mapErr, unwrapOr, and isOk.',
    defaultPath: 'src/resultBox.ts', exports: ['ResultBox'],
    patterns: [{ re: '\\bResultBox\\b', weight: 0.6 }, { re: 'result.*type|ok.*err.*monad', weight: 0.3 }],
    impl: `export class ResultBox<T, E> {
  private constructor(private value: T | null, private error: E | null, private okFlag: boolean) {}
  static ok<T, E = unknown>(v: T): ResultBox<T, E> { return new ResultBox<T, E>(v, null, true) }
  static err<E, T = unknown>(e: E): ResultBox<T, E> { return new ResultBox<T, E>(null, e, false) }
  map<U>(fn: (v: T) => U): ResultBox<U, E> { return this.okFlag ? ResultBox.ok<U, E>(fn(this.value as T)) : ResultBox.err<E, U>(this.error as E) }
  mapErr<F>(fn: (e: E) => F): ResultBox<T, F> { return this.okFlag ? ResultBox.ok<T, F>(this.value as T) : ResultBox.err<F, T>(fn(this.error as E)) }
  unwrapOr(def: T): T { return this.okFlag ? (this.value as T) : def }
  isOk(): boolean { return this.okFlag }
}`,
    tests: [
      { desc: 'ok unwrap', call: 'ResultBox.ok(5).unwrapOr(0)', want: '5' },
      { desc: 'err unwrap', call: 'ResultBox.err<string,number>("bad").unwrapOr(9)', want: '9' },
      { desc: 'map ok', call: 'ResultBox.ok<number,string>(3).map(x=>x*2).unwrapOr(0)', want: '6' },
      { desc: 'map err skips', call: 'ResultBox.err<string,number>("x").map(x=>x*2).unwrapOr(-1)', want: '-1' },
      { desc: 'mapErr', call: 'ResultBox.err<string,number>("oops").mapErr(e=>e.length).unwrapOr(0)', want: '0' },
      { desc: 'isOk true', call: 'ResultBox.ok(1).isOk()', want: 'true' },
      { desc: 'isOk false', call: 'ResultBox.err("e").isOk()', want: 'false' },
    ],
  },
  {
    id: 'compose-pipe', filename: 'composePipe',
    summary: 'composeFns composes functions right-to-left and pipeFns left-to-right; empty input yields identity.',
    defaultPath: 'src/composePipe.ts', exports: ['composeFns', 'pipeFns'],
    patterns: [{ re: '\\bcomposeFns\\b|\\bpipeFns\\b', weight: 0.6 }, { re: 'compose.*function|pipe.*function', weight: 0.3 }],
    impl: `export function composeFns(...fns: Array<(x: any) => any>): (x: any) => any {
  return (x: any) => fns.reduceRight((v, f) => f(v), x)
}
export function pipeFns(...fns: Array<(x: any) => any>): (x: any) => any {
  return (x: any) => fns.reduce((v, f) => f(v), x)
}`,
    tests: [
      { desc: 'compose right to left', call: 'composeFns((x:number)=>x*2,(x:number)=>x+1)(3)', want: '8' },
      { desc: 'pipe left to right', call: 'pipeFns((x:number)=>x+1,(x:number)=>x*2)(3)', want: '8' },
      { desc: 'compose empty identity', call: 'composeFns()(42)', want: '42' },
      { desc: 'pipe empty identity', call: 'pipeFns()(42)', want: '42' },
      { desc: 'pipe three', call: 'pipeFns((x:number)=>x+1,(x:number)=>x*2,(x:number)=>x-3)(0)', want: '-1' },
      { desc: 'compose single', call: 'composeFns((x:number)=>x*5)(4)', want: '20' },
    ],
  },
  {
    id: 'curry-n', filename: 'curryN',
    summary: 'curryN curries a function to a fixed arity, collecting arguments until the arity is reached.',
    defaultPath: 'src/curryN.ts', exports: ['curryN'],
    patterns: [{ re: '\\bcurryN\\b', weight: 0.6 }, { re: 'curry.*arity|curry.*function', weight: 0.3 }],
    impl: `export function curryN(fn: (...args: any[]) => any, arity: number): (...args: any[]) => any {
  return function curried(...args: any[]): any {
    if (args.length >= arity) return fn(...args.slice(0, arity))
    return (...more: any[]) => curried(...args, ...more)
  }
}`,
    tests: [
      { desc: 'one at a time', call: 'curryN((a:number,b:number,c:number)=>a+b+c,3)(1)(2)(3)', want: '6' },
      { desc: 'all at once', call: 'curryN((a:number,b:number)=>a*b,2)(3,4)', want: '12' },
      { desc: 'partial split', call: 'curryN((a:number,b:number,c:number)=>a+b+c,3)(1,2)(3)', want: '6' },
      { desc: 'arity one', call: 'curryN((a:number)=>a+10,1)(5)', want: '15' },
      { desc: 'ignores extra', call: 'curryN((a:number,b:number)=>a+b,2)(1,2,3)', want: '3' },
    ],
  },
  {
    id: 'all-any-pass', filename: 'allAnyPass',
    summary: 'allPass returns a predicate true when every predicate passes; anyPass true when any passes.',
    defaultPath: 'src/allAnyPass.ts', exports: ['allPass', 'anyPass'],
    patterns: [{ re: '\\ballPass\\b|\\banyPass\\b', weight: 0.6 }, { re: 'predicate.*combin|combine.*predicate', weight: 0.3 }],
    impl: `export function allPass<T>(preds: Array<(x: T) => boolean>): (x: T) => boolean {
  return (x: T) => preds.every(p => p(x))
}
export function anyPass<T>(preds: Array<(x: T) => boolean>): (x: T) => boolean {
  return (x: T) => preds.some(p => p(x))
}`,
    tests: [
      { desc: 'allPass true', call: 'allPass<number>([x=>x>0,x=>x<10])(5)', want: 'true' },
      { desc: 'allPass false', call: 'allPass<number>([x=>x>0,x=>x<10])(15)', want: 'false' },
      { desc: 'anyPass true', call: 'anyPass<number>([x=>x>100,x=>x<0])(-5)', want: 'true' },
      { desc: 'anyPass false', call: 'anyPass<number>([x=>x>100,x=>x<0])(5)', want: 'false' },
      { desc: 'allPass empty true', call: 'allPass<number>([])(1)', want: 'true' },
      { desc: 'anyPass empty false', call: 'anyPass<number>([])(1)', want: 'false' },
    ],
  },
  {
    id: 'memoize-unary', filename: 'memoizeUnary',
    summary: 'memoizeUnary memoizes a single-argument function, caching results in a Map keyed by the argument.',
    defaultPath: 'src/memoizeUnary.ts', exports: ['memoizeUnary'],
    patterns: [{ re: '\\bmemoizeUnary\\b', weight: 0.6 }, { re: 'memoize.*function|cache.*function result', weight: 0.3 }],
    impl: `export function memoizeUnary<A, R>(fn: (x: A) => R): (x: A) => R {
  const cache = new Map<A, R>()
  return (x: A): R => {
    if (cache.has(x)) return cache.get(x) as R
    const r = fn(x); cache.set(x, r); return r
  }
}`,
    tests: [
      { desc: 'correct value', call: 'memoizeUnary((x:number)=>x*2)(5)', want: '10' },
      { desc: 'caches', call: '(() => { let n=0; const f=memoizeUnary((x:number)=>{n++;return x}); f(1); f(1); f(1); return n })()', want: '1' },
      { desc: 'distinct args', call: '(() => { let n=0; const f=memoizeUnary((x:number)=>{n++;return x}); f(1); f(2); f(1); return n })()', want: '2' },
      { desc: 'returns cached', call: '(() => { let n=0; const f=memoizeUnary((x:number)=>++n); return [f(7),f(7)] })()', want: '[1,1]' },
    ],
  },
  {
    id: 'zip-with', filename: 'zipWith',
    summary: 'zipWith combines two arrays elementwise with a function, up to the shorter length.',
    defaultPath: 'src/zipWith.ts', exports: ['zipWith'],
    patterns: [{ re: '\\bzipWith\\b', weight: 0.6 }, { re: 'zip.*function|elementwise.*combine', weight: 0.3 }],
    impl: `export function zipWith<A, B, R>(a: A[], b: B[], fn: (x: A, y: B) => R): R[] {
  const n = Math.min(a.length, b.length), out: R[] = []
  for (let i = 0; i < n; i++) out.push(fn(a[i], b[i]))
  return out
}`,
    tests: [
      { desc: 'add', call: 'zipWith([1,2,3],[10,20,30],(a,b)=>a+b)', want: '[11,22,33]' },
      { desc: 'shorter b', call: 'zipWith([1,2,3],[10,20],(a,b)=>a+b)', want: '[11,22]' },
      { desc: 'empty', call: 'zipWith([],[1,2],(a,b)=>a)', want: '[]' },
      { desc: 'pairs', call: 'zipWith([1,2],["a","b"],(a,b)=>[a,b])', want: '[[1,"a"],[2,"b"]]' },
      { desc: 'multiply', call: 'zipWith([2,3],[4,5],(a,b)=>a*b)', want: '[8,15]' },
    ],
  },
  {
    id: 'negate-predicate', filename: 'negatePredicate',
    summary: 'negate returns the logical complement of a predicate function.',
    defaultPath: 'src/negatePredicate.ts', exports: ['negate'],
    patterns: [{ re: '\\bnegate\\b', weight: 0.6 }, { re: 'complement.*predicate|negate.*function', weight: 0.3 }],
    impl: `export function negate<A extends any[]>(pred: (...args: A) => boolean): (...args: A) => boolean {
  return (...args: A) => !pred(...args)
}`,
    tests: [
      { desc: 'negates true', call: 'negate((x:number)=>x>0)(5)', want: 'false' },
      { desc: 'negates false', call: 'negate((x:number)=>x>0)(-5)', want: 'true' },
      { desc: 'isEven to isOdd', call: 'negate((x:number)=>x%2===0)(3)', want: 'true' },
      { desc: 'multi-arg', call: 'negate((a:number,b:number)=>a>b)(1,2)', want: 'true' },
      { desc: 'double negate', call: 'negate(negate((x:number)=>x>0))(5)', want: 'true' },
    ],
  },
]
const out = path.join(HERE, 'fpB.json'); fs.writeFileSync(out, JSON.stringify(entries, null, 2)); console.log(`wrote ${entries.length} → ${out}`)
