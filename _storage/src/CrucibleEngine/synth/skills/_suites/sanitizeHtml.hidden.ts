import { stripTags, sanitizeHtml } from '../src/module'
let f = 0
const ok = (b: boolean, msg: string) => { if (!b) { console.error('FAIL', msg); f++ } }
ok(stripTags('<b>hello</b> <i>world</i>') === 'hello world', 'strip tags')
ok(stripTags('no tags') === 'no tags', 'no tags passthrough')
ok(stripTags('') === '', 'empty string')
const clean = sanitizeHtml('<b onclick="xss()">hello</b> <script>evil()</script> <a href="https://x.com">link</a>')
ok(!clean.includes('onclick'), 'removes event handlers')
ok(!clean.includes('<script>'), 'removes script tags')
ok(clean.includes('<b>'), 'keeps b tag')
ok(clean.includes('<a'), 'keeps a tag')
ok(!sanitizeHtml('<img src=x onerror=alert(1)>').includes('onerror'), 'removes img onerror')
ok(sanitizeHtml('<p>hello</p>').includes('<p>'), 'keeps p tag')
console.log(f === 0 ? 'ALL PASS' : `${f} FAILURE(S)`); process.exit(f === 0 ? 0 : 1)
