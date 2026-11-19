// The apps the Connect wizard knows: what each speaks, and the exact settings with a token filled in.

export type Dialect = 'openai' | 'anthropic' | 'ollama'

export interface ConnectTarget {
  /** e.g. 192.168.1.20 or myserver.local */
  host: string
  openaiPort: number
  ollamaPort: number
  model: string
  token: string
}

export interface Snippet {
  id: string
  label: string
  lang: 'sh' | 'json' | 'yaml' | 'python' | 'js' | 'text' | 'powershell'
  /** where it goes, in plain words */
  where?: string
  code: string
}

export interface AppField {
  label: string
  value: string
  secret?: boolean
}

export interface ConnectApp {
  id: string
  name: string
  /** the app name the gateway gives its requests (common/apps.py) */
  recognizedAs: string[]
  dialect: Dialect
  blurb: string
  tokenName: string
  listeners: Array<'openai' | 'ollama'>
  fields: (t: ConnectTarget) => AppField[]
  snippets: (t: ConnectTarget) => Snippet[]
  steps?: string[]
  note?: string
  /** what the QR code holds */
  qr: (t: ConnectTarget) => string
}

const openaiBase = (t: ConnectTarget) => `http://${t.host}:${t.openaiPort}/v1`
const anthropicBase = (t: ConnectTarget) => `http://${t.host}:${t.openaiPort}`
const ollamaBase = (t: ConnectTarget) => `http://${t.host}:${t.ollamaPort}`

const openaiFields = (t: ConnectTarget): AppField[] => [
  { label: 'Base URL', value: openaiBase(t) },
  { label: 'API key', value: t.token, secret: true },
  { label: 'Model', value: t.model },
]

export const APPS: ConnectApp[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    recognizedAs: ['Claude Code'],
    dialect: 'anthropic',
    blurb: 'Anthropic API on port 8080',
    tokenName: 'claude-code',
    listeners: ['openai'],
    fields: (t) => [
      { label: 'ANTHROPIC_BASE_URL', value: anthropicBase(t) },
      { label: 'ANTHROPIC_AUTH_TOKEN', value: t.token, secret: true },
      { label: 'ANTHROPIC_MODEL', value: t.model },
    ],
    snippets: (t) => [
      {
        id: 'env',
        label: 'Shell',
        lang: 'sh',
        where: 'In the terminal you start Claude Code from (or your shell profile)',
        code: `export ANTHROPIC_BASE_URL=${anthropicBase(t)}
export ANTHROPIC_AUTH_TOKEN=${t.token}
export ANTHROPIC_MODEL=${t.model}
export ANTHROPIC_SMALL_FAST_MODEL=${t.model}
claude`,
      },
      {
        id: 'settings',
        label: 'settings.json',
        lang: 'json',
        where: '~/.claude/settings.json',
        code: JSON.stringify(
          {
            env: {
              ANTHROPIC_BASE_URL: anthropicBase(t),
              ANTHROPIC_AUTH_TOKEN: t.token,
              ANTHROPIC_MODEL: t.model,
              ANTHROPIC_SMALL_FAST_MODEL: t.model,
            },
          },
          null,
          2,
        ),
      },
      {
        id: 'ps',
        label: 'PowerShell',
        lang: 'powershell',
        where: 'Windows',
        code: `$env:ANTHROPIC_BASE_URL = "${anthropicBase(t)}"
$env:ANTHROPIC_AUTH_TOKEN = "${t.token}"
$env:ANTHROPIC_MODEL = "${t.model}"
$env:ANTHROPIC_SMALL_FAST_MODEL = "${t.model}"
claude`,
      },
    ],
    qr: (t) => `ANTHROPIC_BASE_URL=${anthropicBase(t)}\nANTHROPIC_AUTH_TOKEN=${t.token}\nANTHROPIC_MODEL=${t.model}`,
  },
  {
    id: 'open-webui',
    name: 'Open WebUI',
    recognizedAs: ['Open WebUI'],
    dialect: 'openai',
    blurb: 'OpenAI API connection',
    tokenName: 'open-webui',
    listeners: ['openai'],
    fields: openaiFields,
    steps: ['Admin Panel → Settings → Connections', 'Add an OpenAI API connection with the URL and key below', 'Save; the model appears in the model list'],
    snippets: (t) => [
      {
        id: 'docker',
        label: 'Docker env',
        lang: 'sh',
        where: 'Environment of the Open WebUI container',
        code: `OPENAI_API_BASE_URL=${openaiBase(t)}
OPENAI_API_KEY=${t.token}`,
      },
    ],
    qr: (t) => `${openaiBase(t)}\n${t.token}`,
  },
  {
    id: 'continue',
    name: 'Continue',
    recognizedAs: ['Continue'],
    dialect: 'openai',
    blurb: 'VS Code / JetBrains',
    tokenName: 'continue',
    listeners: ['openai'],
    fields: openaiFields,
    snippets: (t) => [
      {
        id: 'yaml',
        label: 'config.yaml',
        lang: 'yaml',
        where: '~/.continue/config.yaml',
        code: `models:
  - name: Qwen3.8 Flash (${t.host})
    provider: openai
    model: ${t.model}
    apiBase: ${openaiBase(t)}
    apiKey: ${t.token}
    roles: [chat, edit, apply]`,
      },
    ],
    qr: (t) => `${openaiBase(t)}\n${t.token}`,
  },
  {
    id: 'cline',
    name: 'Cline',
    recognizedAs: ['Cline'],
    dialect: 'openai',
    blurb: 'OpenAI Compatible provider',
    tokenName: 'cline',
    listeners: ['openai'],
    fields: openaiFields,
    steps: ['Cline settings → API Provider: “OpenAI Compatible”', 'Base URL, API Key and Model ID from below', 'Turn off “Supports Images” if you do not need pictures'],
    snippets: () => [],
    qr: (t) => `${openaiBase(t)}\n${t.token}`,
  },
  {
    id: 'aider',
    name: 'Aider',
    recognizedAs: ['Aider', 'aider'],
    dialect: 'openai',
    blurb: 'Terminal pair programmer',
    tokenName: 'aider',
    listeners: ['openai'],
    fields: openaiFields,
    snippets: (t) => [
      {
        id: 'env',
        label: 'Shell',
        lang: 'sh',
        code: `export OPENAI_API_BASE=${openaiBase(t)}
export OPENAI_API_KEY=${t.token}
aider --model openai/${t.model}`,
      },
    ],
    qr: (t) => `${openaiBase(t)}\n${t.token}`,
  },
  {
    id: 'zed',
    name: 'Zed',
    recognizedAs: ['Zed'],
    dialect: 'openai',
    blurb: 'OpenAI-compatible provider',
    tokenName: 'zed',
    listeners: ['openai'],
    fields: openaiFields,
    steps: ['Add the provider to settings.json', 'Agent panel → Settings → paste the token as its API key'],
    snippets: (t) => [
      {
        id: 'json',
        label: 'settings.json',
        lang: 'json',
        where: '~/.config/zed/settings.json',
        code: JSON.stringify(
          {
            language_models: {
              openai_compatible: {
                [t.host.split('.')[0] || 'computer']: {
                  api_url: openaiBase(t),
                  available_models: [{ name: t.model, display_name: 'Qwen3.8 Flash', max_tokens: 262144 }],
                },
              },
            },
          },
          null,
          2,
        ),
      },
    ],
    qr: (t) => `${openaiBase(t)}\n${t.token}`,
  },
  {
    id: 'librechat',
    name: 'LibreChat',
    recognizedAs: ['LibreChat'],
    dialect: 'openai',
    blurb: 'Custom endpoint',
    tokenName: 'librechat',
    listeners: ['openai'],
    fields: openaiFields,
    snippets: (t) => [
      {
        id: 'yaml',
        label: 'librechat.yaml',
        lang: 'yaml',
        code: `endpoints:
  custom:
    - name: "${t.host.split('.')[0] || 'computer'}"
      apiKey: "${t.token}"
      baseURL: "${openaiBase(t)}"
      models:
        default: ["${t.model}"]
        fetch: true
      titleConvo: true
      titleModel: "current_model"`,
      },
    ],
    qr: (t) => `${openaiBase(t)}\n${t.token}`,
  },
  {
    id: 'n8n',
    name: 'n8n',
    recognizedAs: ['n8n'],
    dialect: 'openai',
    blurb: 'OpenAI credentials',
    tokenName: 'n8n',
    listeners: ['openai'],
    fields: openaiFields,
    steps: ['Credentials → New → OpenAI', 'API Key: the token; Base URL: below', 'Use it in an OpenAI Chat Model node; type the model name by hand'],
    snippets: () => [],
    qr: (t) => `${openaiBase(t)}\n${t.token}`,
  },
  {
    id: 'home-assistant',
    name: 'Home Assistant',
    recognizedAs: ['Home Assistant'],
    dialect: 'ollama',
    blurb: 'Ollama integration, port 11434',
    tokenName: 'home-assistant',
    listeners: ['ollama'],
    fields: (t) => [
      { label: 'URL', value: ollamaBase(t) },
      { label: 'Token (Authorization: Bearer)', value: t.token, secret: true },
      { label: 'Model', value: t.model },
    ],
    steps: ['Settings → Devices & services → Add integration → Ollama', 'URL from below; pick the model', 'The gateway needs the token in an Authorization header'],
    note: 'If your Home Assistant cannot send the token header, Access has a token-less option for its address only, on the Ollama port only. It is off unless you turn it on.',
    snippets: (t) => [
      {
        id: 'curl',
        label: 'Check',
        lang: 'sh',
        code: `curl ${ollamaBase(t)}/api/tags -H "Authorization: Bearer ${t.token}"`,
      },
    ],
    qr: (t) => `${ollamaBase(t)}\n${t.token}`,
  },
  {
    id: 'openai-python',
    name: 'OpenAI SDK',
    recognizedAs: ['openai-python', 'openai-node'],
    dialect: 'openai',
    blurb: 'Python and JavaScript',
    tokenName: 'openai-sdk',
    listeners: ['openai'],
    fields: openaiFields,
    snippets: (t) => [
      {
        id: 'py',
        label: 'Python',
        lang: 'python',
        code: `from openai import OpenAI

client = OpenAI(base_url="${openaiBase(t)}", api_key="${t.token}")
r = client.chat.completions.create(
    model="${t.model}",
    messages=[{"role": "user", "content": "Hello from Python"}],
)
print(r.choices[0].message.content)`,
      },
      {
        id: 'js',
        label: 'JavaScript',
        lang: 'js',
        code: `import OpenAI from 'openai'

const client = new OpenAI({ baseURL: '${openaiBase(t)}', apiKey: '${t.token}' })
const r = await client.chat.completions.create({
  model: '${t.model}',
  messages: [{ role: 'user', content: 'Hello from JavaScript' }],
})
console.log(r.choices[0].message.content)`,
      },
    ],
    qr: (t) => `${openaiBase(t)}\n${t.token}`,
  },
  {
    id: 'anthropic-python',
    name: 'Anthropic SDK',
    recognizedAs: ['anthropic-python', 'anthropic-node'],
    dialect: 'anthropic',
    blurb: 'Python and JavaScript',
    tokenName: 'anthropic-sdk',
    listeners: ['openai'],
    fields: (t) => [
      { label: 'Base URL', value: anthropicBase(t) },
      { label: 'API key', value: t.token, secret: true },
      { label: 'Model', value: t.model },
    ],
    snippets: (t) => [
      {
        id: 'py',
        label: 'Python',
        lang: 'python',
        code: `import anthropic

client = anthropic.Anthropic(base_url="${anthropicBase(t)}", api_key="${t.token}")
m = client.messages.create(
    model="${t.model}",
    max_tokens=512,
    messages=[{"role": "user", "content": "Hello from Python"}],
)
print(m.content[0].text)`,
      },
      {
        id: 'js',
        label: 'JavaScript',
        lang: 'js',
        code: `import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic({ baseURL: '${anthropicBase(t)}', apiKey: '${t.token}' })
const m = await client.messages.create({
  model: '${t.model}',
  max_tokens: 512,
  messages: [{ role: 'user', content: 'Hello from JavaScript' }],
})
console.log(m.content[0].text)`,
      },
    ],
    qr: (t) => `${anthropicBase(t)}\n${t.token}`,
  },
  {
    id: 'ollama-python',
    name: 'Ollama clients',
    recognizedAs: ['ollama-python', 'ollama-js', 'Enchanted', 'Obsidian', 'Raycast'],
    dialect: 'ollama',
    blurb: 'ollama-python, Obsidian, Enchanted…',
    tokenName: 'ollama-client',
    listeners: ['ollama'],
    fields: (t) => [
      { label: 'Host', value: ollamaBase(t) },
      { label: 'Token (Authorization: Bearer)', value: t.token, secret: true },
      { label: 'Model', value: t.model },
    ],
    snippets: (t) => [
      {
        id: 'py',
        label: 'Python',
        lang: 'python',
        code: `from ollama import Client

client = Client(host="${ollamaBase(t)}", headers={"Authorization": "Bearer ${t.token}"})
r = client.chat(model="${t.model}", messages=[{"role": "user", "content": "Hello"}])
print(r.message.content)`,
      },
    ],
    qr: (t) => `${ollamaBase(t)}\n${t.token}`,
  },
  {
    id: 'curl',
    name: 'curl',
    recognizedAs: ['curl'],
    dialect: 'openai',
    blurb: 'A quick check from any computer',
    tokenName: 'curl-test',
    listeners: ['openai', 'ollama'],
    fields: openaiFields,
    snippets: (t) => [
      {
        id: 'chat',
        label: 'Chat',
        lang: 'sh',
        code: `curl ${openaiBase(t)}/chat/completions \\
  -H "Authorization: Bearer ${t.token}" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "${t.model}", "messages": [{"role": "user", "content": "Say hello"}], "max_tokens": 64}'`,
      },
      {
        id: 'models',
        label: 'Models',
        lang: 'sh',
        code: `curl ${openaiBase(t)}/models -H "Authorization: Bearer ${t.token}"`,
      },
    ],
    qr: (t) => `${openaiBase(t)}\n${t.token}`,
  },
]

export function appById(id: string | undefined | null): ConnectApp | undefined {
  return APPS.find((a) => a.id === id)
}

/** The gateway recognized this request as coming from the app (by User-Agent), or the request used its token. */
export function matchesApp(app: ConnectApp, recognized: string | null | undefined): boolean {
  return !!recognized && app.recognizedAs.some((n) => n.toLowerCase() === recognized.toLowerCase())
}

/** Monogram for an app name: "Claude Code" -> "CC", "n8n" -> "n8" */
export function monogram(name: string | null | undefined): string {
  if (!name) return '?'
  const words = name.replace(/[^A-Za-z0-9 ]/g, ' ').trim().split(/\s+/)
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase()
  return name.slice(0, 2)
}
