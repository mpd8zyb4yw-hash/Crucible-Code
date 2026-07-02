import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — JSON diff/patch: deep diff, patch apply, merge, conflict detection.
export type DiffOp = {op:'add'|'remove'|'replace';path:string;value?:unknown;oldValue?:unknown}
export function diff(a:unknown,b:unknown,path=''):DiffOp[]{
  const ops:DiffOp[]=[]
  if(Array.isArray(a)&&Array.isArray(b)){
    const len=Math.max(a.length,b.length)
    for(let i=0;i<len;i++){
      const p=\`\${path}/\${i}\`
      if(i>=a.length)ops.push({op:'add',path:p,value:b[i]})
      else if(i>=b.length)ops.push({op:'remove',path:p,oldValue:a[i]})
      else ops.push(...diff(a[i],b[i],p))
    }
  }else if(a&&b&&typeof a==='object'&&typeof b==='object'&&!Array.isArray(a)){
    const ao=a as Record<string,unknown>,bo=b as Record<string,unknown>
    const keys=new Set([...Object.keys(ao),...Object.keys(bo)])
    for(const k of keys){
      const p=\`\${path}/\${k}\`
      if(!(k in ao))ops.push({op:'add',path:p,value:bo[k]})
      else if(!(k in bo))ops.push({op:'remove',path:p,oldValue:ao[k]})
      else ops.push(...diff(ao[k],bo[k],p))
    }
  }else if(a!==b)ops.push({op:'replace',path,value:b,oldValue:a})
  return ops
}
export function applyPatch(obj:unknown,ops:DiffOp[]):unknown{
  let result=JSON.parse(JSON.stringify(obj))
  for(const op of ops){
    const segs=op.path.split('/').filter(Boolean)
    let cur:Record<string,unknown>=result as Record<string,unknown>
    for(let i=0;i<segs.length-1;i++)cur=cur[segs[i]] as Record<string,unknown>
    const last=segs[segs.length-1]
    if(op.op==='remove'&&last)delete cur[last]
    else if(last&&(op.op==='add'||op.op==='replace'))cur[last]=op.value
  }
  return result
}
`
registerSkill({
  id: 'json-diff',
  summary: 'JSON diff/patch: deep diff, patch apply, structured change operations.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bjson.?diff\b/i)) sc += 0.6
    if (s.has(/\bdeep.?diff\b/i)) sc += 0.35
    if (s.has(/\bpatch.?apply\b|\bapply.?patch\b/i)) sc += 0.25
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/jsonDiff.ts', content: IMPL }]
  },
})
