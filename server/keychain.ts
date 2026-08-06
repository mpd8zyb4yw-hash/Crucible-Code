import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

const SERVICE = 'crucible'

/**
 * API keys live in the macOS keychain, not in a dotfile and not in the
 * renderer. The `security` CLI is used rather than a native module so there is
 * no build step and no dependency to audit.
 *
 * Known tradeoff: `security add-generic-password -w <key>` puts the secret in
 * argv, which is briefly visible to `ps` for other processes running as this
 * user. On a single-user desktop that is an acceptable exposure; it is called
 * out here so it is a decision rather than an oversight. Reading and deleting
 * do not carry the secret in argv.
 */

export async function setKey(account: string, key: string): Promise<void> {
  // -U updates in place if the item already exists instead of erroring.
  await run('security', ['add-generic-password', '-s', SERVICE, '-a', account, '-w', key, '-U'])
}

export async function getKey(account: string): Promise<string | null> {
  try {
    const { stdout } = await run('security', ['find-generic-password', '-s', SERVICE, '-a', account, '-w'])
    const key = stdout.trim()
    return key.length ? key : null
  } catch {
    // `security` exits non-zero when the item simply isn't there.
    return null
  }
}

export async function deleteKey(account: string): Promise<boolean> {
  try {
    await run('security', ['delete-generic-password', '-s', SERVICE, '-a', account])
    return true
  } catch {
    return false
  }
}
