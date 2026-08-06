import { isUrl, isUuid, isIp, isIpv4, isIpv6 } from '../src/module'
let f = 0
const ok = (b: boolean, msg: string) => { if (!b) { console.error('FAIL', msg); f++ } }
ok(isUrl('https://example.com'), 'valid https')
ok(isUrl('http://a.b/path?q=1'), 'valid http with query')
ok(!isUrl('ftp://example.com'), 'ftp not valid')
ok(!isUrl('not-a-url'), 'invalid')
ok(!isUrl(''), 'empty invalid')
ok(isUuid('550e8400-e29b-41d4-a716-446655440000'), 'valid uuid')
ok(!isUuid('550e8400-e29b-41d4-a716-44665544000z'), 'invalid uuid char')
ok(!isUuid('not-a-uuid'), 'not a uuid')
ok(isIpv4('192.168.1.1'), 'valid ipv4')
ok(isIpv4('0.0.0.0'), 'ipv4 zeros')
ok(!isIpv4('256.0.0.1'), 'invalid ipv4 octet')
ok(!isIpv4('1.2.3'), 'too few octets')
ok(isIpv6('2001:db8::1'), 'valid ipv6 abbrev')
ok(!isIp('not-an-ip'), 'not an ip')
ok(isIp('127.0.0.1'), 'loopback is ip')
console.log(f === 0 ? 'ALL PASS' : `${f} FAILURE(S)`); process.exit(f === 0 ? 0 : 1)
