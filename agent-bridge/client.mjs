/**
 * Command client — the thing ChatGPT does, done locally.
 *
 * Sends one command envelope to the account itself and waits for the matching
 * result in the same thread. Used by the self-test to exercise the real Gmail
 * path rather than calling the executor directly.
 */
import { BRIDGE_ID, CMD_PREFIX, PROTOCOL, RESULT_PREFIX } from './config.mjs'
import * as gmail from './gmail.mjs'

export async function sendCommand({ job_id, step_id, op, args = {}, bridge_id, omit = [] }) {
  const me = await gmail.profile()
  const envelope = { protocol: PROTOCOL, bridge_id: bridge_id ?? BRIDGE_ID, job_id, step_id, op, args }
  for (const k of omit) delete envelope[k]
  const sent = await gmail.send({
    to: me,
    subject: `${CMD_PREFIX} ${BRIDGE_ID} ${job_id}`,
    text: JSON.stringify(envelope, null, 1),
  })
  return sent
}

/** Poll the thread for the result carrying this job/step. */
export async function awaitResult({ job_id, step_id, timeout_ms = 120_000 }) {
  const me = await gmail.profile()
  const deadline = Date.now() + timeout_ms
  while (Date.now() < deadline) {
    let ids = []
    try { ids = await gmail.listIds(`in:sent to:${me} subject:"${RESULT_PREFIX}" newer_than:1d`, 25) }
    catch { await new Promise((r) => setTimeout(r, 3000)); continue }
    for (const id of ids) {
      let msg
      try { msg = await gmail.getMessage(id) } catch { continue }
      const subject = gmail.header(msg, 'Subject')
      if (!subject.includes(job_id) || !subject.includes(`#${step_id}`)) continue
      const body = gmail.plainBody(msg)
      try { return { message: msg, result: JSON.parse(body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1)) } } catch { return { message: msg, raw: body } }
    }
    await new Promise((r) => setTimeout(r, 2500))
  }
  return null
}
