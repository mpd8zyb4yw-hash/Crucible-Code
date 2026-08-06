import { jwtDecode, isJwtExpired } from '../src/module'
let f = 0
const ok = (b: boolean, msg: string) => { if (!b) { console.error('FAIL', msg); f++ } }
const h = Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url')
const p = Buffer.from(JSON.stringify({sub:'123',exp:9999999999,iat:1000000})).toString('base64url')
const token = h + '.' + p + '.fakesig'
const d = jwtDecode(token)
ok(d.header.alg === 'HS256', 'header.alg')
ok(d.header.typ === 'JWT', 'header.typ')
ok(d.payload.sub === '123', 'payload.sub')
ok(d.payload.exp === 9999999999, 'payload.exp')
ok(d.signature === 'fakesig', 'signature')
ok(!isJwtExpired(token), 'not expired')
const ep = Buffer.from(JSON.stringify({exp:1})).toString('base64url')
ok(isJwtExpired(h + '.' + ep + '.sig'), 'expired')
let threw = false; try { jwtDecode('bad') } catch { threw = true }
ok(threw, 'throws on invalid')
console.log(f === 0 ? 'ALL PASS' : `${f} FAILURE(S)`); process.exit(f === 0 ? 0 : 1)
