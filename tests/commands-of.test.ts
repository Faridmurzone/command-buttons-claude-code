import { describe, expect, test } from 'claude-code/testing'

import { blocksOf, splitCommands } from '../hooks/commands-of'

const fence = (language: string, body: string) =>
  ['```' + language, body, '```'].join('\n')

describe('commands-of', () => {
  test('a gcloud binding across continuations is one command', () => {
    const command = [
      'gcloud projects add-iam-policy-binding example-project \\',
      '  --member="group:devops@example.com" \\',
      '  --role="roles/redis.admin" \\',
      '  --condition=None',
    ].join('\n')

    const blocks = blocksOf(`Corré esto:\n\n${fence('bash', command)}\n`)

    expect(blocks.length).toBe(1)
    expect(blocks[0]!.commands).toEqual([command])
  })

  test('two commands in one fence are two commands', () => {
    const body = ['gcloud services enable redis.googleapis.com', 'gcloud redis instances list'].join('\n')

    expect(splitCommands(body)).toEqual([
      'gcloud services enable redis.googleapis.com',
      'gcloud redis instances list',
    ])
  })

  test('a loop is offered whole, never split at its newlines', () => {
    const body = ['for p in a b c; do', '  gcloud config set project $p', 'done'].join('\n')

    expect(splitCommands(body)).toEqual([body])
  })

  test('a heredoc keeps its body', () => {
    const body = ["cat > f.yaml <<'EOF'", 'kind: Service', 'EOF', 'kubectl apply -f f.yaml'].join('\n')

    expect(splitCommands(body)).toEqual([
      ["cat > f.yaml <<'EOF'", 'kind: Service', 'EOF'].join('\n'),
      'kubectl apply -f f.yaml',
    ])
  })

  test('a comment rides with the command beneath it', () => {
    expect(splitCommands('# el binding va al grupo\ngcloud projects add-iam-policy-binding x')).toEqual([
      '# el binding va al grupo\ngcloud projects add-iam-policy-binding x',
    ])
  })

  test('a && chain stays one command', () => {
    const body = 'cd /Users/farid/Code/uma/cd &&\nnpm test'

    expect(splitCommands(body)).toEqual([body])
  })

  test('non-shell fences are left alone', () => {
    expect(blocksOf(fence('sql', 'SELECT 1'))).toEqual([])
    expect(blocksOf(fence('json', '{"a": 1}'))).toEqual([])
  })

  test('a fence still streaming grows no buttons', () => {
    expect(blocksOf('```bash\ngcloud projects add-iam-policy-b')).toEqual([])
  })

  test('pasted output is not a command', () => {
    expect(blocksOf(fence('', '{\n  "ok": true\n}'))).toEqual([])
  })

  test('an unlabelled fence holding a command counts', () => {
    expect(blocksOf(fence('', 'kubectl get pods -n nomed'))[0]!.commands).toEqual([
      'kubectl get pods -n nomed',
    ])
  })
})
