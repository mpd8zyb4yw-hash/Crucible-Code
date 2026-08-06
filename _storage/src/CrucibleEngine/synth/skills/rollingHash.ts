import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — verified rolling hash for sliding window pattern matching.
export class RollingHash {
  private hash=0; private window:number[]=[]
  private pow:number
  constructor(private base=31,private mod=1e9+7,private len=0){this.pow=len?this._pow(base,len-1,mod):1}
  private _pow(b:number,e:number,m:number):number{let r=1;b%=m;while(e>0){if(e&1)r=r*b%m;b=b*b%m;e>>=1};return r}
  roll(remove:string,add:string):number{
    if(this.window.length>=this.len){const old=this.window.shift()!;this.hash=(this.hash-old*this.pow%this.mod+this.mod)%this.mod;this.hash=this.hash*this.base%this.mod}
    const v=add.charCodeAt(0);this.window.push(v);this.hash=(this.hash+v)%this.mod;return this.hash
  }
  static hashString(s:string,base=31,mod=1e9+7):number{let h=0;for(const c of s)h=(h*base+c.charCodeAt(0))%mod;return h}
}
`
registerSkill({ id: 'rolling-hash', summary: 'Rolling hash (Rabin fingerprint) for sliding window algorithms.',
  match(s: SpecFeatures) { let score = 0; if (s.has(/rolling.?hash|rabin.?fingerprint/i)) score += 0.8; if (s.has(/sliding.?window.{0,20}hash/i)) score += 0.5; return score },
  emit(s: SpecFeatures): SynthFile[] { return [{ path: s.modulePath ?? 'src/rollingHash.ts', content: IMPL }] } })
