import type { EngineInterface, On, RenderElement } from 'claude-code'

import { blocksOf } from './commands-of'

/**
 * A short stable digest of `text` (djb2): the identity a command's state
 * (armed, running, its last output) is kept under, shared by every place the
 * same command is drawn — the message's own box and the quick band above the
 * prompt both key off it, so running it from either shows in both.
 */
function digestOf(text: string): string {
  let hash = 5381

  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0
  }

  return (hash >>> 0).toString(36)
}

/** How much of a command a message-box row shows beside its buttons. */
const PREVIEW_MIN = 24

/** Room the two bracket buttons and their gaps take on a message-box row. */
const BUTTONS_WIDTH = 30

/** What the message-box frame itself takes: its border, padding and margin. */
const FRAME_WIDTH = 6

/** Room the two plain, hotkeyed buttons take on a quick-band row. */
const ABOVE_BUTTONS_WIDTH = 22

/** How many of the latest reply's commands the band offers: one digit each. */
const MAX_ABOVE_PROMPT_COMMANDS = 9

/** How many lines of a command's output are drawn before "+N more". */
const OUTPUT_MAX_LINES = 6

/** Clipboard commands to try, in order, until one is on the machine. */
const CLIPBOARDS = [
  ['pbcopy'],
  ['wl-copy'],
  ['xclip', '-selection', 'clipboard'],
  ['xsel', '--clipboard', '--input'],
]

type Engine = EngineInterface

type Options = {
  runInBackground?: boolean
  confirmPattern?: string
  maxButtons?: string
}

/** What a run left behind, kept until the next press replaces it. */
type Output = {
  text: string
  isError: boolean
}

/** The state a press reads and updates, shared by every row of one command. */
type Ctx = {
  options: Options
  confirms: RegExp | null
  armed: Set<string>
  running: Set<string>
  outputs: Map<string, Output>
}

type Handlers = {
  run: () => void
  take: () => void
}

/**
 * Puts `text` on the system clipboard, answering which tool took it.
 *
 * @param $ the engine interface
 * @param text the command to copy
 * @returns the tool that took it, or null when the machine has none
 */
async function copy($: Engine, text: string): Promise<string | null> {
  for (const argv of CLIPBOARDS) {
    try {
      const { exitCode } = await $.process.run(argv, {
        stdin: text,
        timeoutMs: 5000,
      })

      if (exitCode === 0) {
        return argv[0] ?? null
      }
    } catch {
      // Not on this machine, or it refused the text: try the next one.
    }
  }

  return null
}

/**
 * Runs `command` the way the model's own Bash calls do, and answers what it
 * left behind. Toasts on a denial or a thrown error; a plain result is left
 * for the caller to draw.
 *
 * @param $ the engine interface
 * @param command the shell command to run
 * @param options the manifest's `userConfig`
 */
async function runCommand(
  $: Engine,
  command: string,
  options: Options,
): Promise<Output> {
  try {
    const response = await $.tool.call({
      tool: 'Bash',
      command,
      description: 'Run the command the assistant proposed',
      ...(options.runInBackground === true ? { run_in_background: true } : {}),
    })

    if (response.deny !== undefined) {
      $.ui.toast(`Denied: ${response.deny}`, { timeoutMs: 8000 })

      return { text: response.deny, isError: true }
    }

    return { text: response.text ?? '', isError: response.isError === true }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)

    $.ui.toast(`Did not run: ${reason}`, { timeoutMs: 8000 })

    return { text: reason, isError: true }
  }
}

/**
 * The `onPress` closures one row needs, built once per draw: pressing Run
 * arms a confirm-gated command on its first press and runs it on its second
 * (or its only press, when nothing gates it); pressing Copy never runs
 * anything. Both read and write `ctx`'s Sets and Map by `id`, so a press from
 * the quick band and a press from the message box agree on one command's
 * state.
 *
 * @param $ the engine interface
 * @param id the command's identity (`digestOf`), not the row's own key
 * @param command the shell command this row offers
 * @param ctx the state shared by every row of this plugin
 */
function handlersFor(
  $: Engine,
  id: string,
  command: string,
  ctx: Ctx,
): Handlers {
  const needsConfirm = ctx.confirms !== null && ctx.confirms.test(command)

  const run = () => {
    if (ctx.running.has(id)) {
      return
    }

    if (needsConfirm && !ctx.armed.has(id)) {
      ctx.armed.add(id)
      $.ui.invalidate('ui.render')
      $.ui.toast('Sensitive command: press again to confirm', {
        timeoutMs: 6000,
      })

      return
    }

    ctx.armed.delete(id)
    ctx.running.add(id)
    ctx.outputs.delete(id)
    $.ui.invalidate('ui.render')

    void runCommand($, command, ctx.options)
      .then(output => {
        ctx.outputs.set(id, output)
      })
      .finally(() => {
        ctx.running.delete(id)
        $.ui.invalidate('ui.render')
      })
  }

  const take = () => {
    void copy($, command).then(tool => {
      $.ui.toast(
        tool === null
          ? 'No clipboard tool found (pbcopy or equivalent)'
          : 'Command copied',
        { timeoutMs: 2500 },
      )
    })
  }

  return { run, take }
}

/**
 * `output.text`, cut to `width` columns and `OUTPUT_MAX_LINES` lines, with
 * trailing blank lines dropped so a command that prints one line doesn't
 * leave empty rows under it.
 *
 * @param output what the run resolved with
 * @param width how wide one line of it may draw
 * @returns the lines to draw, and how many more there were past the cap
 */
function previewOf(
  output: Output,
  width: number,
): { lines: string[]; more: number } {
  const all = output.text.split('\n')

  while (all.length > 0 && all[all.length - 1]!.trim() === '') {
    all.pop()
  }

  if (all.length === 0) {
    return { lines: ['(no output)'], more: 0 }
  }

  const shown = all.slice(0, OUTPUT_MAX_LINES).map(line =>
    line.length > width ? `${line.slice(0, width - 1)}…` : line,
  )

  return { lines: shown, more: Math.max(0, all.length - OUTPUT_MAX_LINES) }
}

/** A command on one line, its `\` continuations folded away. */
function singleLineOf(command: string): string {
  return command.replace(/\\\s*\n\s*/g, ' ').replace(/\s+/g, ' ')
}

/** `text`, cut to `width` columns with an ellipsis. */
function clip(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, width - 1)}…` : text
}

/**
 * Draws `[ Run ]` and `[ Copy ]` under every shell block of an assistant
 * message, framed apart from its prose, with the run's output under its row;
 * and mirrors the latest finished reply's commands as a hotkeyed band above
 * the prompt (`1`, `2`, … to run; `a`, `b`, … to copy), so the last one
 * never needs the mouse.
 *
 * Running goes through `$.tool.call`, so the command takes the session's
 * permission path and lands in the transcript as its own `Bash` row too.
 * Nothing runs without a press, and a command the confirm pattern names
 * takes two.
 *
 * @param on the engine's registrar
 * @param options the manifest's `userConfig`, as the person set it
 */
export function register(on: On, options: Options = {}) {
  const ctx: Ctx = {
    options,
    confirms: (() => {
      const source = options.confirmPattern ?? ''

      if (source.trim() === '') {
        return null
      }

      try {
        return new RegExp(source, 'i')
      } catch {
        return null
      }
    })(),
    armed: new Set<string>(),
    running: new Set<string>(),
    outputs: new Map<string, Output>(),
  }

  const maxButtons = (() => {
    const parsed = Number.parseInt(options.maxButtons ?? '8', 10)

    return Number.isFinite(parsed) && parsed > 0 ? parsed : 8
  })()

  /**
   * The latest reply's text blocks, by `requestId`: a re-render (a resize,
   * a streamed chunk) replaces its own entry rather than appending to it, so
   * a block still growing never leaves a stale prefix behind. `isFirstOfReply`
   * starts a new reply and drops every entry from the one before it.
   */
  const replyBlocks = new Map<string, string>()

  /** `replyBlocks`, in the order its entries were last touched. */
  const latestReplyText = () => [...replyBlocks.values()].join('\n')

  on(
    'ui.render',
    { component: 'AssistantMessage' },
    async ($: any, e: any, next: any): Promise<RenderElement> => {
      const base = await next(e)
      const text: string = e.props?.text ?? ''

      if (e.props?.isFirstOfReply === true) {
        replyBlocks.clear()
      }

      if (text !== '') {
        replyBlocks.set(e.requestId, text)
      }

      if (text === '' || (!text.includes('```') && !text.includes('~~~'))) {
        return base
      }

      const commands = blocksOf(text)
        .flatMap(block => block.commands)
        .slice(0, maxButtons)

      if (commands.length === 0) {
        return base
      }

      const { Box, Text, Button } = await $.ui.resolve(e)
      const columns: number = e.viewport?.columns ?? 80
      const preview = Math.max(
        PREVIEW_MIN,
        columns - BUTTONS_WIDTH - FRAME_WIDTH - 4,
      )
      const outputWidth = Math.max(PREVIEW_MIN, columns - FRAME_WIDTH - 2)

      const rows = commands.map((command, index) => {
        const id = digestOf(command)
        const elementKey = `${e.requestId}:${index}:${id}`
        const { run, take } = handlersFor($ as Engine, id, command, ctx)

        const isArmed = ctx.armed.has(id)
        const isRunning = ctx.running.has(id)
        const output = ctx.outputs.get(id)
        const outputLines =
          output === undefined ? null : previewOf(output, outputWidth)

        const label = isRunning
          ? '⋯ Running'
          : isArmed
            ? '⚠ Confirm'
            : '▶ Run'

        return (
          <Box key={elementKey} flexDirection="column">
            <Box flexDirection="row" gap={1}>
              <Button
                key={`run:${elementKey}`}
                label={label}
                dimColor={isRunning}
                onPress={run}
              />
              <Button
                key={`copy:${elementKey}`}
                label="⧉ Copy"
                onPress={take}
              />
              <Text dimColor wrap="truncate-end">
                {clip(singleLineOf(command), preview)}
              </Text>
            </Box>
            {output === undefined ? null : (
              <Box flexDirection="column" marginLeft={2}>
                {outputLines!.lines.map((line, lineIndex) => (
                  <Text
                    key={`out:${elementKey}:${lineIndex}`}
                    dimColor={!output.isError}
                    color={output.isError ? 'red' : undefined}
                    wrap="truncate-end"
                  >
                    {line}
                  </Text>
                ))}
                {outputLines!.more > 0 ? (
                  <Text dimColor>… (+{outputLines!.more} more lines)</Text>
                ) : null}
              </Box>
            )}
          </Box>
        )
      })

      return (
        <Box flexDirection="column">
          {base}
          <Box
            flexDirection="column"
            borderStyle="round"
            borderDimColor
            paddingX={1}
            marginLeft={2}
            marginTop={1}
            alignSelf="flex-start"
          >
            {rows}
          </Box>
        </Box>
      )
    },
  )

  on(
    'ui.render',
    { component: 'AbovePrompt' },
    async ($: any, e: any, next: any): Promise<RenderElement> => {
      // A survey (a permission ask, a question) owns the band while it runs.
      if (e.props?.hasSurvey === true) {
        return next(e)
      }

      const below = await next(e)

      // Mid-turn the latest reply's fences aren't closed yet, so this would
      // otherwise show the reply before it — stale commands for a live turn.
      if (e.props?.isWorking === true) {
        return below
      }

      const text = latestReplyText()

      if (text === '') {
        return below
      }

      // A digest per command: two identical commands in one reply would
      // otherwise draw two Buttons under the same key, which the engine
      // refuses to draw (a real key, not just an address, must be unique).
      const commands = [
        ...new Map(
          blocksOf(text)
            .flatMap(block => block.commands)
            .map(command => [digestOf(command), command] as const),
        ).values(),
      ]

      if (commands.length === 0) {
        return below
      }

      const maxRows: number = e.props?.maxRows ?? 0
      const withHeader = maxRows >= 2
      const capacity = Math.max(0, withHeader ? maxRows - 1 : maxRows)
      const shown = commands.slice(
        0,
        Math.min(MAX_ABOVE_PROMPT_COMMANDS, capacity),
      )

      // Below the fold (no room even for one row): leave the band as is
      // rather than force a scroll, which would drop the digit hotkeys.
      if (shown.length === 0) {
        return below
      }

      const { Box, Text, Button } = await $.ui.resolve(e)
      const bodyColumns: number = e.props?.bodyColumns ?? 80
      const preview = Math.max(PREVIEW_MIN, bodyColumns - ABOVE_BUTTONS_WIDTH)

      const rows = shown.map((command, index) => {
        const id = digestOf(command)
        const { run, take } = handlersFor($ as Engine, id, command, ctx)
        const digit = String(index + 1)
        const letter = String.fromCharCode(97 + index)

        const isArmed = ctx.armed.has(id)
        const isRunning = ctx.running.has(id)
        const runLabel = isRunning ? 'Running' : isArmed ? 'Confirm' : 'Run'

        return (
          <Box key={`above:${id}`} flexDirection="row" gap={1}>
            <Button
              key={`above:run:${id}`}
              hotkey={digit}
              plain
              label={runLabel}
              dimColor={isRunning}
              onPress={run}
            />
            <Button
              key={`above:copy:${id}`}
              hotkey={letter}
              plain
              label="Copy"
              onPress={take}
            />
            <Text dimColor wrap="truncate-end">
              {clip(singleLineOf(command), preview)}
            </Text>
          </Box>
        )
      })

      return (
        <Box flexDirection="column">
          {below}
          {withHeader ? (
            <Text dimColor>Quick run — last reply:</Text>
          ) : null}
          {rows}
        </Box>
      )
    },
  )
}
