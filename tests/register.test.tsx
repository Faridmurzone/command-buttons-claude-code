import { describe, expect, test } from 'claude-code/testing'

const COMMAND = [
  'gcloud projects add-iam-policy-binding example-project \\',
  '  --member="group:devops@example.com" \\',
  '  --role="roles/redis.admin" \\',
  '  --condition=None',
].join('\n')

const TEXT = `El binding va al grupo:\n\n\`\`\`bash\n${COMMAND}\n\`\`\`\n`

/** What the engine would have drawn: the plain text of the message. */
const base = async ($: any, e: any) => {
  const { Text } = await $.ui.resolve(e)

  return <Text>{e.props.text}</Text>
}

const draw = ($: any, text: string) =>
  $.ui.render({
    component: 'AssistantMessage',
    surface: 'terminal',
    requestId: 'msg-1',
    props: { text, isFirstOfReply: true },
    viewport: { columns: 120, rows: 40 },
  })

/** Every Button in a drawn tree, by its key. */
function buttonsOf(node: any, found: Record<string, any> = {}): Record<string, any> {
  if (node === null || typeof node !== 'object') {
    return found
  }

  if (Array.isArray(node)) {
    for (const child of node) buttonsOf(child, found)

    return found
  }

  if (node.type === 'Button') {
    found[node.props?.key ?? node.props?.label] = node.props
  }

  buttonsOf(node.children, found)

  return found
}

/** Every Text node's own string children, in tree order. */
function textsOf(node: any, found: string[] = []): string[] {
  if (node === null || typeof node !== 'object') {
    return found
  }

  if (Array.isArray(node)) {
    for (const child of node) textsOf(child, found)

    return found
  }

  if (node.type === 'Text') {
    for (const child of node.children ?? []) {
      if (typeof child === 'string') {
        found.push(child)
      }
    }
  }

  textsOf(node.children, found)

  return found
}

/** Silences `$.ui.invalidate` and `$.ui.toast` for a test that presses a run. */
function stubUi(on: any) {
  on('ui.invalidate', () => ({}))
  on('ui.toast', () => ({}))
}

/** The first Text node's own props whose children include `content`. */
function findText(node: any, content: string): any {
  if (node === null || typeof node !== 'object') {
    return undefined
  }

  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findText(child, content)

      if (found !== undefined) {
        return found
      }
    }

    return undefined
  }

  if (node.type === 'Text' && (node.children ?? []).includes(content)) {
    return node.props ?? {}
  }

  return findText(node.children, content)
}

describe('register', () => {
  test('a shell fence grows a Run and a Copy button', async ($, on) => {
    on('ui.render', base)

    const tree = await draw($, TEXT)
    const labels = Object.values(buttonsOf(tree)).map((p: any) => p.label)

    expect(labels).toContain('▶ Run')
    expect(labels).toContain('⧉ Copy')
  })

  test('prose with no fence is left as the engine drew it', async ($, on) => {
    on('ui.render', base)

    const tree = await draw($, 'No hay comandos acá, solo texto.')

    expect(buttonsOf(tree)).toEqual({})
  })

  test('pressing Run calls Bash with the whole command', async ($, on) => {
    const ran: string[] = []

    on('ui.render', base)
    stubUi(on)
    on('tool.call', ($, e: any) => {
      ran.push(e.command)

      return { result: { stdout: 'Updated IAM policy.', stderr: '' }, text: 'ok' } as any
    })

    const tree = await draw($, TEXT)
    const key = Object.keys(buttonsOf(tree)).find(k => k.startsWith('run:'))

    expect(key).toBeDefined()

    await $.ui.press({ plugin: 'command-buttons', key: key! })

    expect(ran).toEqual([COMMAND])
  })

  test('a finished run draws its output under the row, not just a toast', async ($, on) => {
    on('ui.render', base)
    stubUi(on)
    on('tool.call', () => ({ result: { stdout: 'file1.txt\nfile2.txt', stderr: '' }, text: 'file1.txt\nfile2.txt' }) as any)

    const before = await draw($, TEXT)
    const key = Object.keys(buttonsOf(before)).find(k => k.startsWith('run:'))!

    await $.ui.press({ plugin: 'command-buttons', key })

    const after = await draw($, TEXT)

    expect(textsOf(after)).toContain('file1.txt')
    expect(textsOf(after)).toContain('file2.txt')
  })

  test('a failed run draws its output in red, not dim', async ($, on) => {
    on('ui.render', base)
    stubUi(on)
    on('tool.call', () => ({ isError: true, result: 'boom', text: 'boom: not found' }) as any)

    const before = await draw($, TEXT)
    const key = Object.keys(buttonsOf(before)).find(k => k.startsWith('run:'))!

    await $.ui.press({ plugin: 'command-buttons', key })

    const after: any = await draw($, TEXT)
    const outputText = findText(after, 'boom: not found')

    expect(outputText).toBeDefined()
    expect(outputText.color).toBe('red')
    expect(outputText.dimColor).toBe(false)
  })

  test('pressing Copy sends the command to a clipboard, runs nothing', async ($, on) => {
    const copied: string[] = []
    const ran: string[] = []

    on('ui.render', base)
    stubUi(on)
    on('tool.call', ($, e: any) => {
      ran.push(e.command)

      return { result: {}, text: 'ok' } as any
    })
    on('process.run', ($, e: any) => {
      copied.push(e.init?.stdin ?? '')

      return { value: { exitCode: 0, stdout: '', stderr: '' } } as any
    })

    const tree = await draw($, TEXT)
    const key = Object.keys(buttonsOf(tree)).find(k => k.startsWith('copy:'))

    await $.ui.press({ plugin: 'command-buttons', key: key! })

    expect(copied).toEqual([COMMAND])
    expect(ran).toEqual([])
  })

  test('a destructive command runs only on the second press', async ($, on) => {
    const ran: string[] = []
    const destructive = 'kubectl delete deployment cortex -n nomed'
    const text = ['Ojo con esto:', '', '```bash', destructive, '```'].join('\n')

    on('ui.render', base)
    stubUi(on)
    on('tool.call', ($, e: any) => {
      ran.push(e.command)

      return { result: {}, text: 'ok' } as any
    })

    const first = await draw($, text)
    const key = Object.keys(buttonsOf(first)).find(k => k.startsWith('run:'))!

    await $.ui.press({ plugin: 'command-buttons', key })

    expect(ran).toEqual([])

    const armed = await draw($, text)

    expect(buttonsOf(armed)[key]!.label).toBe('⚠ Confirm')

    await $.ui.press({ plugin: 'command-buttons', key })

    expect(ran).toEqual([destructive])
  })

  test('two blocks of one reply key their buttons apart', async ($, on) => {
    on('ui.render', base)

    const text = [
      '```bash', 'echo uno', '```', '', 'y despues', '', '```bash', 'echo dos', '```',
    ].join('\n')

    const keys = Object.keys(buttonsOf(await draw($, text))).filter(k => k.startsWith('run:'))

    expect(keys.length).toBe(2)
    expect(new Set(keys).size).toBe(2)
  })

  test('los botones van en una cajita, separados del texto', async ($, on) => {
    on('ui.render', base)

    const tree: any = await draw($, TEXT)
    const frame = tree.children.find(
      (child: any) => child?.props?.borderStyle !== undefined,
    )

    expect(frame.props.borderStyle).toBe('round')
    expect(frame.props.borderDimColor).toBe(true)
    expect(buttonsOf(frame)).not.toEqual({})
  })

  test('una cajita por mensaje, no una por comando', async ($, on) => {
    on('ui.render', base)

    const text = ['```bash', 'echo uno', 'echo dos', 'echo tres', '```'].join('\n')
    const tree: any = await draw($, text)
    const frames = tree.children.filter(
      (child: any) => child?.props?.borderStyle !== undefined,
    )

    expect(frames.length).toBe(1)
    expect(frames[0].children.length).toBe(3)
  })
})

describe('AbovePrompt band', () => {
  const drawMessage = ($: any, text: string, requestId = 'msg-1') =>
    $.ui.render({
      component: 'AssistantMessage',
      surface: 'terminal',
      requestId,
      props: { text, isFirstOfReply: true },
      viewport: { columns: 120, rows: 40 },
    })

  const drawAbove = ($: any, props: Record<string, unknown> = {}) =>
    $.ui.render({
      component: 'AbovePrompt',
      surface: 'terminal',
      requestId: 'above-1',
      props: {
        hasSurvey: false,
        isWorking: false,
        maxRows: 6,
        bodyColumns: 100,
        scroll: {},
        view: {},
        ...props,
      },
      viewport: { columns: 120, rows: 40 },
    })

  test('mirrors the latest reply as digit/letter hotkeys, plain style', async ($, on) => {
    on('ui.render', base)

    await drawMessage($, '```bash\necho hola\n```')
    const tree: any = await drawAbove($)

    const buttons = buttonsOf(tree)
    const run = Object.values(buttons).find((p: any) => p.hotkey === '1')
    const copy = Object.values(buttons).find((p: any) => p.hotkey === 'a')

    expect(run.label).toBe('Run')
    expect(run.plain).toBe(true)
    expect(copy.label).toBe('Copy')
  })

  test('a message with no commands leaves the band as the engine drew it', async ($, on) => {
    on('ui.render', base)

    await drawMessage($, 'solo texto, sin comandos')
    const tree: any = await drawAbove($)

    expect(buttonsOf(tree)).toEqual({})
  })

  test('a survey holding the band is left untouched', async ($, on) => {
    on('ui.render', base)

    await drawMessage($, '```bash\necho hola\n```')
    const tree: any = await drawAbove($, { hasSurvey: true })

    expect(buttonsOf(tree)).toEqual({})
  })

  test('only as many rows as maxRows allows, so digit hotkeys stay live', async ($, on) => {
    on('ui.render', base)

    const text = ['```bash', 'echo one', 'echo two', 'echo three', 'echo four', '```'].join('\n')
    await drawMessage($, text)

    // header (1) + 2 rows fits in maxRows: 3
    const tree: any = await drawAbove($, { maxRows: 3 })
    const runButtons = Object.values(buttonsOf(tree)).filter((p: any) => p.hotkey !== 'a' && /^[1-9]$/.test(p.hotkey ?? ''))

    expect(runButtons.length).toBe(2)
  })

  test('maxRows too small for even one row leaves the band untouched', async ($, on) => {
    on('ui.render', base)

    await drawMessage($, '```bash\necho hola\n```')
    const tree: any = await drawAbove($, { maxRows: 0 })

    expect(buttonsOf(tree)).toEqual({})
  })

  test('pressing the band\'s Run shares state with the message box below it', async ($, on) => {
    const ran: string[] = []

    on('ui.render', base)
    stubUi(on)
    on('tool.call', ($, e: any) => {
      ran.push(e.command)
      return { result: { stdout: 'ok' }, text: 'ok' } as any
    })

    await drawMessage($, TEXT)
    const above: any = await drawAbove($)
    const runKey = Object.keys(buttonsOf(above)).find(k => k.startsWith('above:run:'))!

    await $.ui.press({ plugin: 'command-buttons', key: runKey })

    expect(ran).toEqual([COMMAND])

    const box: any = await drawMessage($, TEXT)

    expect(textsOf(box)).toContain('ok')
  })

  test('an interleaved reply (text, tool call, more text) is read whole', async ($, on) => {
    on('ui.render', base)

    await drawMessage($, 'Dale, hago esto primero:', 'msg-2')
    await drawMessage($, '```bash\necho after-tool-call\n```', 'msg-2')

    const tree: any = await drawAbove($)

    expect(Object.keys(buttonsOf(tree)).some(k => k.startsWith('above:run:'))).toBe(true)
  })

  test('a later, unrelated reply replaces the band, not appends to it', async ($, on) => {
    on('ui.render', base)

    await drawMessage($, '```bash\necho first-reply\n```', 'msg-1')
    await drawMessage($, '```bash\necho second-reply\n```', 'msg-2')

    const tree: any = await drawAbove($)

    expect(textsOf(tree)).toContain('echo second-reply')
    expect(textsOf(tree)).not.toContain('echo first-reply')
  })

  test('a streaming block re-rendered mid-growth never leaves a stale prefix', async ($, on) => {
    on('ui.render', base)

    // Same block (same requestId), redrawn as it grows: the fence isn't
    // closed yet on the first two frames, closes on the third.
    await drawMessage($, 'Now run:\n\n```bash\n', 'msg-1')
    await drawMessage($, 'Now run:\n\n```bash\necho x', 'msg-1')
    await drawMessage($, 'Now run:\n\n```bash\necho x\n```', 'msg-1')

    const tree: any = await drawAbove($)
    const runButtons = Object.values(buttonsOf(tree)).filter(
      (p: any) => /^[1-9]$/.test(p.hotkey ?? ''),
    )

    expect(runButtons.length).toBe(1)
    expect(textsOf(tree)).toContain('echo x')
    expect(textsOf(tree)).not.toContain('Now run:')
  })

  test('a repeated command in one reply draws one button, not two', async ($, on) => {
    on('ui.render', base)

    const text = ['```bash', 'echo again', '```', '', 'y otra vez', '', '```bash', 'echo again', '```'].join('\n')
    await drawMessage($, text)

    const tree: any = await drawAbove($)
    const runButtons = Object.values(buttonsOf(tree)).filter(
      (p: any) => /^[1-9]$/.test(p.hotkey ?? ''),
    )

    expect(runButtons.length).toBe(1)
  })

  test('a turn still running shows nothing new, not the unclosed reply', async ($, on) => {
    on('ui.render', base)

    await drawMessage($, '```bash\necho done-already\n```', 'msg-1')

    const tree: any = await drawAbove($, { isWorking: true })

    expect(buttonsOf(tree)).toEqual({})
  })
})
