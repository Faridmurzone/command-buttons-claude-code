/**
 * Finds the shell commands a markdown message offers to run.
 *
 * Only closed fences count: a fence still streaming has no terminator yet, so
 * a half-written command never grows a button it would run truncated.
 */

/** Info strings whose fence holds shell, plus the unlabelled fence. */
const SHELL_LANGUAGES = new Set([
  '',
  'bash',
  'sh',
  'shell',
  'shell-session',
  'zsh',
  'console',
  'terminal',
  'cmd',
  'gcloud',
])

/**
 * Openers that make the lines beneath them one statement. A block holding any
 * of them is offered whole: splitting `for`/`if`/`case` at its newlines would
 * hand `done` to the shell on its own.
 */
const BLOCK_OPENERS =
  /^(for|while|until|if|elif|else|then|fi|do|done|case|esac|function|\}|\{)\b/

/** A line that opens a heredoc, capturing the word that closes it. */
const HEREDOC = /<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/

/** A line whose statement continues on the next one. */
const CONTINUES = /(\\|&&|\|\||\||;)\s*$/

/** What a fence holds when it is output pasted back, not a command. */
const NOT_A_COMMAND = /^\s*[[{<]|^\s*(\d{4}-\d{2}-\d{2}|[A-Z]+:|\||[+-]{3}\s)/

export type Block = {
  /** The fence's whole body, as the message drew it. */
  body: string
  /** The commands it offers, in order; one entry for a fence kept whole. */
  commands: string[]
}

/** True when `text` reads as a command rather than as pasted output. */
function isCommand(text: string): boolean {
  const first = text.split('\n').find(line => line.trim() !== '')

  if (first === undefined) {
    return false
  }

  return !NOT_A_COMMAND.test(first)
}

/**
 * Splits a fence body into the commands it holds, or keeps it whole when its
 * lines depend on each other.
 *
 * A comment rides with the command beneath it, so copying one carries what it
 * is for.
 */
export function splitCommands(body: string): string[] {
  const lines = body.split('\n')
  const commands: string[] = []

  let current: string[] = []
  let heredoc: string | null = null

  for (const line of lines) {
    const trimmed = line.trim()

    if (heredoc !== null) {
      current.push(line)

      if (trimmed === heredoc) {
        heredoc = null
        commands.push(current.join('\n').trim())
        current = []
      }

      continue
    }

    if (BLOCK_OPENERS.test(trimmed)) {
      return [body.trim()]
    }

    if (trimmed === '') {
      if (current.length > 0) {
        commands.push(current.join('\n').trim())
        current = []
      }

      continue
    }

    current.push(line)

    const opener = HEREDOC.exec(line)

    if (opener) {
      heredoc = opener[1] ?? null
      continue
    }

    if (CONTINUES.test(trimmed) || trimmed.startsWith('#')) {
      continue
    }

    commands.push(current.join('\n').trim())
    current = []
  }

  if (current.length > 0) {
    commands.push(current.join('\n').trim())
  }

  const kept = commands.filter(command => {
    const bare = command
      .split('\n')
      .filter(line => !line.trim().startsWith('#'))
      .join('\n')
      .trim()

    return bare !== ''
  })

  return kept.length === 0 ? [] : kept
}

/**
 * The shell blocks of a markdown message, each with the commands it offers.
 *
 * @param text the message's markdown, as the transcript draws it
 */
export function blocksOf(text: string): Block[] {
  const lines = text.split('\n')
  const blocks: Block[] = []

  let fence: { marker: string; language: string; body: string[] } | null = null

  for (const line of lines) {
    const opener = /^\s*(```+|~~~+)\s*([A-Za-z0-9_+-]*)\s*$/.exec(line)

    if (fence === null) {
      if (opener) {
        fence = {
          marker: opener[1]!.slice(0, 3),
          language: (opener[2] ?? '').toLowerCase(),
          body: [],
        }
      }

      continue
    }

    const closes = /^\s*(```+|~~~+)\s*$/.exec(line)

    if (closes && closes[1]!.startsWith(fence.marker)) {
      const body = fence.body.join('\n')

      if (SHELL_LANGUAGES.has(fence.language) && isCommand(body)) {
        const commands = splitCommands(body)

        if (commands.length > 0) {
          blocks.push({ body, commands })
        }
      }

      fence = null
      continue
    }

    fence.body.push(line)
  }

  return blocks
}

/** Every command a message offers, in the order it drew them. */
export function commandsOf(text: string): string[] {
  return blocksOf(text).flatMap(block => block.commands)
}
