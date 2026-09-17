# command-buttons

A Claude Code plugin that adds instant **Run** and **Copy** buttons to every shell command in Claude's responses, plus a quick-access hotkey band above the prompt.

![version](https://img.shields.io/badge/version-0.1.0-blue)
![license](https://img.shields.io/badge/license-MIT-green)
![claude-code](https://img.shields.io/badge/claude%20code-2.1.273%2B-orange)

## Why command-buttons?

Claude often suggests shell commands, but copying and running them involves:
- Selecting text carefully (especially with line continuations)
- Opening a terminal or new window  
- Finding the command again if you need to run a variant

**command-buttons** eliminates all that friction. With one click—or one keystroke—you run the exact command Claude proposed, see the output right there in the transcript, and copy it just as easily.

## Features

- **Inline buttons** on every shell block (`[ ▶ Run ]` `[ ⧉ Copy ]`), framed to stand out from prose
- **Output inline** under each command, up to 6 lines, in red if it fails
- **Hotkey band** above the prompt: `1`–`9` to run, `a`–`i` to copy the latest reply's commands, **no mouse required**
- **Confirmation gate** on destructive commands (`kubectl delete`, `terraform destroy`, `--force`, etc.)
- **State shared** between the message box and the band: run from either place, see it update in both
- **Permission-aware**: runs through Claude's own permission system; no secret extraction or bypasses
- **Typed**, tested, and built as a Claude Code function hook

## Installation

### Prerequisites
- **Claude Code 2.1.273** or later
- **Function hooks enabled**: set `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` in `~/.claude/settings.json`

### Quick Start

```bash
# Clone or download this repo
git clone https://github.com/faridmurzone/command-buttons-claude-code.git ~/.claude/skills/command-buttons

# Verify the plugin loads
claude plugin validate ~/.claude/skills/command-buttons
```

The plugin auto-loads as `command-buttons@skills-dir` on your next Claude Code session.

### Manual Install

1. Copy the repo into `~/.claude/skills/command-buttons`
2. Add to `~/.claude/settings.json`:
   ```json
   {
     "env": {
       "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1"
     }
   }
   ```
3. Restart Claude Code

## Usage

### Message Box (Mouse)
Every shell fence in Claude's reply gets a bracketed button row:
```
  gcloud projects add-iam-policy-binding example-project \
    --role="roles/editor"

  [ ▶ Run ]  [ ⧉ Copy ]  gcloud projects add-iam-policy-binding…
  Updated IAM policy for project [example-project].
```

- **Run** calls `tool.call({ tool: 'Bash' })` — same as the model's own calls
- **Copy** puts the command (with continuations intact) on your clipboard
- Output shows below, in red if it failed

### Quick Band (Keyboard)
Above the prompt, the latest **finished** reply's commands appear as hotkeys:
```
  ╭─ Quick run — last reply: ─────────────────────────────────────╮
  │ 1: Run   a: Copy   gcloud projects add-iam-policy-binding exam…│
  ╰─────────────────────────────────────────────────────────────────╯
  > _
```

- **`1`–`9`** run the command (works with an **empty prompt**)
- **`a`–`i`** copy the command (need **focus on the band** first: click it or `ctrl+x tab`)
- No mouse needed once you memorize the keys

### Safety Gates

Commands matching the confirm pattern (destructive by default) need two presses:
```
  First press:   [ ▶ Run ]  → [ ⚠ Confirm ]
  "Sensitive command: press again to confirm"
  Second press:  [ ⚠ Confirm ]  → runs it
```

Default destructive patterns: `rm -rf`, `kubectl delete`, `terraform destroy`, `--force`, `remove-iam-policy-binding`, `set-iam-policy`, `firestore import|databases`, and any command with `uma-v2` (customize in `/config` → `confirmPattern`).

## Configuration

In Claude Code's `/config` menu, or in `~/.claude/settings.json` under `pluginConfigs["command-buttons@skills-dir"].options`:

| Option | Default | What it does |
|--------|---------|--------------|
| `runInBackground` | `false` | Run with `run_in_background`, keeping the session alive while the command runs. |
| `confirmPattern` | Regex covering destructive ops | Commands matching this pattern need a second press to run. Leave empty to disable. |
| `maxButtons` | `8` | Maximum commands per message to get buttons (others appear in the message box only). |

## Limitations

- **Permission mode**: In **bypass permissions mode**, the click is the only gate. That's the point (human-in-the-loop), but one extra click runs the command. Use `confirmPattern` as your guardrail.
- **Background runs** (`runInBackground: true`): The inline output shows the initial response (which comes back fast with a task ID), not the final result — watch the transcript for long-running commands.
- **Live turns** (`isWorking`): The band only shows finished replies, never mid-turn, so it doesn't offer stale commands while Claude is typing.
- **Scrolling**: If the band is tall and scrolls, the engine disarms digit hotkeys. The plugin respects `maxRows` and won't force a scroll.

## Development

### Run Tests
```bash
claude plugin test ~/.claude/skills/command-buttons   # 31 tests
```

### Validate
```bash
claude plugin validate ~/.claude/skills/command-buttons
```

### Regenerate Types
After updating Claude Code:
```bash
mkdir /tmp/modwork && cd /tmp/modwork
claude -p "/plugin-types"
cp .claude/types/claude-code.d.ts ~/.claude/skills/command-buttons/.claude/types/
```

### Local Development
```bash
claude --plugin-dir ~/.claude/skills/command-buttons
```
The plugin reloads on file save.

## Architecture

- **`hooks/commands-of.ts`**: Parser for shell blocks in Markdown — finds closed fences, deduplicates, handles continuations, heredocs, loops
- **`hooks/register.tsx`**: Two render hooks:
  - `AssistantMessage`: Draws the inline button row and output
  - `AbovePrompt`: Mirrors the latest reply as a hotkey band
- **`tests/`**: 31 tests covering parsing, button state, shared state between hooks, streaming re-renders, and more

The core trick: **state shared by command digest** (`digestOf`), not by location. Run from the message box → it updates in the band. Run from the band → it updates in the message box.

## Roadmap

- [ ] Custom hotkey bindings (instead of fixed 1–9, a–i)
- [ ] Favorites: star commands to pin to the band
- [ ] History: re-run a recent command without typing
- [ ] Syntax highlighting for command output
- [ ] Per-command timeout override

## Contributing

Issues, PRs, and forks welcome. The codebase is TypeScript + React (JSX for render trees), tested with `claude plugin test`, and linted with `tsc`.

## How It Works Behind the Scenes

`command-buttons` is a **Claude Code function hook plugin** — a TypeScript module that decorates Claude's render pipeline. It:

1. Hooks into the `ui.render` event for assistant messages
2. Parses shell blocks using a hand-rolled Markdown fence parser
3. Wraps the engine's own render tree with button rows and output
4. Shares state (armed/running/output) across the message box and the quick band using a content digest as the key
5. Routes presses through `$.tool.call` (so they go through the permission system and land in the transcript)

No monkey-patching, no secrets, no bypass — just one more layer of UI on top of Claude's own execution stack.

## License

MIT. See [LICENSE](./LICENSE).

## Feedback

Found a bug? Want a feature? Open an issue. Want to build on top of this? MIT license makes it easy.

---

**Made with** ❤️ **for people who type faster than they click.**

*This is an early-access plugin for Claude Code function hooks. The API may change between releases — regenerate types after updating Claude Code.*
