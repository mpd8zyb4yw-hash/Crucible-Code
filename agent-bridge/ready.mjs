/** Send the READY handshake. Safe to re-run; it is just another email. */
import { bootstrap, sendReady } from './daemon.mjs'
await bootstrap()
const id = await sendReady()
console.log('READY sent, message id', id)
