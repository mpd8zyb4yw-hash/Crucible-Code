import { execute, extraction } from './.oracle_lib.mjs'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
const files = readdirSync('.').filter(f => f.endsWith('.answer.md'))
const rows = []
for (const f of files) {
  const arm = f.replace(/-\d+\.answer\.md$/,''), run = +f.match(/-(\d+)\.answer\.md$/)[1]
  const txt = readFileSync(f,'utf8')
  if (!txt.trim()) { rows.push({arm,run,empty:true}); continue }
  rows.push({ arm, run, ...extraction(txt), ...execute(txt,'rs-'+arm+run) })
}
writeFileSync('ab_report_rescored.json', JSON.stringify(rows,null,2))
console.log('\n=== cont.88 FINAL (re-scored, oracle 7/7) ===')
for (const arm of ['fm','bonsai_nothink','bonsai_think']) {
  const r = rows.filter(x=>x.arm===arm && !x.empty); if(!r.length) continue
  const p = k=>`${r.filter(k).length}/${r.length}`
  console.log(`${arm.padEnd(15)} copies-z.ipv4(code)=${p(x=>x.usesZIpv4)}  EXECUTES=${p(x=>x.executesCorrectly)}  jsonSchema=${p(x=>x.jsonSchema)}  handRegex=${p(x=>x.handRolledRegex)}`)
}
