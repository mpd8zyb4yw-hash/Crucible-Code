import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — 2D geometry primitives: point, line, polygon, convex hull, area.
export interface Pt { x: number; y: number }
export const cross = (o:Pt,a:Pt,b:Pt) => (a.x-o.x)*(b.y-o.y)-(a.y-o.y)*(b.x-o.x)
export const dot   = (a:Pt,b:Pt) => a.x*b.x+a.y*b.y
export const dist  = (a:Pt,b:Pt) => Math.hypot(a.x-b.x,a.y-b.y)
export const norm  = (p:Pt) => Math.hypot(p.x,p.y)
export const sub   = (a:Pt,b:Pt):Pt => ({x:a.x-b.x,y:a.y-b.y})
export const add   = (a:Pt,b:Pt):Pt => ({x:a.x+b.x,y:a.y+b.y})
export const scale = (p:Pt,s:number):Pt => ({x:p.x*s,y:p.y*s})
export function convexHull(pts: Pt[]): Pt[] {
  const p = pts.slice().sort((a,b)=>a.x-b.x||a.y-b.y)
  const h: Pt[] = []
  for (const pt of p) { while (h.length>=2&&cross(h[h.length-2],h[h.length-1],pt)<=0) h.pop(); h.push(pt) }
  const lo = h.length+1
  for (let i=p.length-2;i>=0;i--) { while (h.length>=lo&&cross(h[h.length-2],h[h.length-1],p[i])<=0) h.pop(); h.push(p[i]) }
  return h.slice(0,-1)
}
export function polygonArea(pts: Pt[]): number {
  let s=0; const n=pts.length
  for (let i=0;i<n;i++){const j=(i+1)%n;s+=pts[i].x*pts[j].y-pts[j].x*pts[i].y}
  return Math.abs(s)/2
}
export function pointInPolygon(p:Pt,poly:Pt[]): boolean {
  let inside=false; const n=poly.length
  for (let i=0,j=n-1;i<n;j=i++) {
    const xi=poly[i].x,yi=poly[i].y,xj=poly[j].x,yj=poly[j].y
    if(((yi>p.y)!==(yj>p.y))&&(p.x<(xj-xi)*(p.y-yi)/(yj-yi)+xi)) inside=!inside
  }
  return inside
}
export function segmentsIntersect(a:Pt,b:Pt,c:Pt,d:Pt): boolean {
  const d1=cross(c,d,a),d2=cross(c,d,b),d3=cross(a,b,c),d4=cross(a,b,d)
  if(((d1>0&&d2<0)||(d1<0&&d2>0))&&((d3>0&&d4<0)||(d3<0&&d4>0))) return true
  return false
}
`
registerSkill({
  id: 'geometry-primitives',
  summary: '2D geometry: cross/dot product, convex hull, polygon area, point-in-polygon, segment intersection.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bconvex.?hull\b/i)) sc += 0.4
    if (s.has(/\bpolygon.?area\b/i)) sc += 0.25
    if (s.has(/\bpoint.?in.?polygon\b/i)) sc += 0.25
    if (s.has(/\b2d.?geometry\b|\bgeometry.?primitiv\b/i)) sc += 0.3
    if (s.has(/\bcross.?product\b/i)) sc += 0.15
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/geometry.ts', content: IMPL }]
  },
})
