import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — Decorator pattern: wrapping, memoize, throttle, retry, log decorators.
export function memoize<A extends unknown[],R>(fn:(...args:A)=>R):(...args:A)=>R{
  const cache=new Map<string,R>()
  return(...args)=>{const k=JSON.stringify(args);if(cache.has(k))return cache.get(k)!;const v=fn(...args);cache.set(k,v);return v}
}
export function throttle<A extends unknown[]>(fn:(...args:A)=>void,ms:number):(...args:A)=>void{
  let last=0;return(...args)=>{const now=Date.now();if(now-last>=ms){last=now;fn(...args)}}
}
export function debounce<A extends unknown[]>(fn:(...args:A)=>void,ms:number):(...args:A)=>void{
  let t:ReturnType<typeof setTimeout>;return(...args)=>{clearTimeout(t);t=setTimeout(()=>fn(...args),ms)}
}
export function retry<A extends unknown[],R>(fn:(...args:A)=>Promise<R>,n=3,delay=200):(...args:A)=>Promise<R>{
  return async(...args)=>{for(let i=0;i<n;i++){try{return await fn(...args)}catch(e){if(i===n-1)throw e;await new Promise(r=>setTimeout(r,delay*2**i))}};throw new Error('unreachable')}
}
export function logged<A extends unknown[],R>(fn:(...args:A)=>R,name=fn.name):(...args:A)=>R{
  return(...args)=>{console.log(\`[\${name}] called\`,args);const r=fn(...args);console.log(\`[\${name}] returned\`,r);return r}
}
export function timed<A extends unknown[],R>(fn:(...args:A)=>R,name=fn.name):(...args:A)=>R{
  return(...args)=>{const t=performance.now();const r=fn(...args);console.log(\`[\${name}] \${(performance.now()-t).toFixed(2)}ms\`);return r}
}
`
registerSkill({
  id: 'decorator-pattern',
  summary: 'Decorator functions: memoize, throttle, debounce, retry, logged, timed.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bdecorator.?pattern\b/i)) sc += 0.4
    if (s.has(/\bmemoize\b/i)) sc += 0.25
    if (s.has(/\bthrottle\b/i) && s.has(/\bdebounce\b/i)) sc += 0.25
    if (s.has(/\bretry\b/i) && s.has(/\bwrap\b/i)) sc += 0.15
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/decorators.ts', content: IMPL }]
  },
})
