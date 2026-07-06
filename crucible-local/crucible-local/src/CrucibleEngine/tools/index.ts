/**
 * Tool-calling surface stub.
 *
 * The real crucible-local repo has `src/CrucibleEngine/tools/` wired to actual
 * tool implementations (file access, shell, web fetch, etc.) — those aren't
 * available in this build environment, so this registry exists to keep the
 * same shape (name → executable) and give the Agents tab something real to
 * call, without inventing capabilities this build can't actually provide.
 *
 * Regression-test the real tool surface against this interface when porting:
 * anything the real tools export as `{ name, description, run(input) }`
 * slots in here unchanged.
 */

export interface Tool {
  name: string
  description: string
  run(input: string): Promise<string>
}

export const tools: Tool[] = [
  {
    name: 'word_count',
    description: 'Counts words and characters in a block of text.',
    async run(input: string) {
      const words = input.trim().split(/\s+/).filter(Boolean).length
      return `${words} words, ${input.length} characters.`
    },
  },
  {
    name: 'json_format',
    description: 'Pretty-prints a JSON blob, or reports why it fails to parse.',
    async run(input: string) {
      try {
        return JSON.stringify(JSON.parse(input), null, 2)
      } catch (e) {
        return `Invalid JSON: ${e instanceof Error ? e.message : String(e)}`
      }
    },
  },
]

export function getTool(name: string): Tool | undefined {
  return tools.find((t) => t.name === name)
}
