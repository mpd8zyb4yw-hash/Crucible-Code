import * as https from 'node:https'
const UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
const url=`https://www.bing.com/search?q=${encodeURIComponent('zod schema validate IPv4 address')}&setlang=en&count=10`
https.get(url,{headers:{'User-Agent':UA,Accept:'text/html,*/*'}},res=>{
  let b=''; res.setEncoding('utf-8'); res.on('data',c=>b+=c); res.on('end',()=>{
    console.log('HTTP', res.statusCode, b.length, 'bytes')
    console.log('contains b_algo :', /<li class="b_algo"/.test(b), '| count:', (b.match(/b_algo/g)||[]).length)
    console.log('contains <h2>   :', (b.match(/<h2>/g)||[]).length)
    // the CURRENT parser regex
    const blockRe=/<li class="b_algo"[\s\S]*?<h2>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h2>([\s\S]*?)<\/li>/g
    let m,n=0; const urls:string[]=[]
    while((m=blockRe.exec(b))!==null && n<10){ urls.push(m[1]); n++ }
    console.log('PARSER YIELD  :', n, 'results')
    urls.slice(0,5).forEach(u=>console.log('   ',u.slice(0,80)))
    if(!n){ const i=b.indexOf('b_algo'); console.log('--- markup near first b_algo ---'); console.log(b.slice(i-60,i+400).replace(/\s+/g,' ')) }
  })
}).on('error',e=>console.log('ERR',e.message))
