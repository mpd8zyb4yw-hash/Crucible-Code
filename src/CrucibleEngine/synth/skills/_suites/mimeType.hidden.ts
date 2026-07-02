import { getMimeType, getExtension, isTextMime } from '../src/module'
let f = 0
const ok = (b: boolean, msg: string) => { if (!b) { console.error('FAIL', msg); f++ } }
ok(getMimeType('index.html') === 'text/html', 'html')
ok(getMimeType('app.js') === 'application/javascript', 'js')
ok(getMimeType('data.json') === 'application/json', 'json')
ok(getMimeType('photo.png') === 'image/png', 'png')
ok(getMimeType('video.mp4') === 'video/mp4', 'mp4')
ok(getMimeType('unknown.xyz') === 'application/octet-stream', 'unknown')
ok(getMimeType('styles.css') === 'text/css', 'css')
ok(getMimeType('data.csv') === 'text/csv', 'csv')
ok(getMimeType('css') === 'text/css', 'bare extension')
ok(getExtension('image/png') === 'png', 'reverse lookup')
ok(getExtension('application/json') === 'json', 'json reverse')
ok(isTextMime('text/html'), 'html is text')
ok(isTextMime('application/json'), 'json is text')
ok(!isTextMime('image/png'), 'png is not text')
console.log(f === 0 ? 'ALL PASS' : `${f} FAILURE(S)`); process.exit(f === 0 ? 0 : 1)
