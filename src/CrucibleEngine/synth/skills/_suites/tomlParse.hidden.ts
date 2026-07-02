import { parseToml } from '../src/module'
let f = 0
const ok = (c: boolean, msg: string) => { if (!c) { console.error('FAIL', msg); f++ } }
const doc = parseToml('title = "Test"\nport = 8080\ndebug = true\nratio = 3.14\n\n[db]\nhost = "localhost"\nports = [5432, 5433]\n\n[[svr]]\nname = "a"\n\n[[svr]]\nname = "b"\n')
ok(doc['title'] === 'Test', 'string')
ok(doc['port'] === 8080, 'int')
ok(doc['debug'] === true, 'bool')
ok(Math.abs((doc['ratio'] as number) - 3.14) < 0.001, 'float')
const db = doc['db'] as any
ok(db['host'] === 'localhost', 'table string')
ok(Array.isArray(db['ports']) && (db['ports'] as number[])[0] === 5432, 'inline array')
const svr = doc['svr'] as any[]
ok(svr.length === 2 && svr[0]['name'] === 'a' && svr[1]['name'] === 'b', 'array of tables')
ok(parseToml('')['__noop'] === undefined, 'empty doc')
ok(parseToml('# comment\nkey = "val"')['key'] === 'val', 'comment stripped')
console.log(f === 0 ? 'ALL PASS' : `${f} FAILURE(S)`); process.exit(f === 0 ? 0 : 1)
