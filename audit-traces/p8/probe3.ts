import * as https from 'node:https'
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
const q = encodeURIComponent('zod schema validate IPv4 address')
const TARGETS: Array<[string,string]> = [
  ['ddgHtml', `https://html.duckduckgo.com/html/?q=${q}`],
  ['bing',    `https://www.bing.com/search?q=${q}&setlang=en&count=10`],
  ['ddgLite', `https://lite.duckduckgo.com/lite/?q=${q}`],
  ['stackexchange', `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${q}&site=stackoverflow&filter=withbody`],
]
function probe(name: string, url: string): Promise<void> {
  return new Promise(resolve => {
    const req = https.get(url, { headers: { 'User-Agent': BROWSER_UA, Accept: '*/*' } }, res => {
      let len = 0
      res.on('data', c => { len += c.length })
      res.on('end', () => { console.log(`${name.padEnd(14)} HTTP ${res.statusCode}  ${len} bytes`); resolve() })
    })
    req.on('error', e => { console.log(`${name.padEnd(14)} ERROR ${e.message}`); resolve() })
    req.setTimeout(8000, () => { req.destroy(); console.log(`${name.padEnd(14)} TIMEOUT`); resolve() })
  })
}
async function main(){ for (const [n,u] of TARGETS) await probe(n,u) }
main()
