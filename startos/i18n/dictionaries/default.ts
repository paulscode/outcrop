export const DEFAULT_LANG = 'en_US'

const dict = {
  // main.ts
  'Web console': 0,
  Models: 1,
  Engine: 2,
  // interfaces.ts
  'Watch, chat, manage presets, tokens and security': 3,
  'OpenAI and Anthropic API': 4,
  'For apps: base URL with /v1 (OpenAI) or without (Anthropic); a token from the console': 5,
  'Ollama API': 6,
  'For apps that speak Ollama; a token from the console': 7,
  'OpenAI and Anthropic API (HTTPS)': 8,
  "The same API with StartOS's certificate": 9,
  // actions
  'Console password': 10,
  'The password to sign in to the web console. "Console password" under Actions shows it for copying; set your own here or generate one. At least 16 characters, and hard to guess.': 11,
  Configure: 12,
  'Configure Outcrop': 13,
  'Show the password for signing in to the web console': 14,
  'Sign in to the web console with this password. Change it with Configure.': 15,
  'Web search': 18,
  // the settings for every preset (actions/config.ts)
  'Exact answers': 19,
  'To save time, the engine leaves out the smallest contributions to each word when they would have to be fetched from RAM or the disk. In our tests on 714 questions this changed no answer, but the wording can differ slightly from the full computation now and then. On computes every word in full: answers match the model exactly, and they come more slowly on a machine that reads from its disk.': 20,
  'Off is faster, and is what we recommend. On gives exactly what the full model would write, more slowly. Changing it restarts Outcrop (a few minutes).': 21,
  'Off: faster (recommended)': 22,
  'On: slower, every answer computed in full': 23,
  'Longest conversation': 24,
  'How much one conversation can hold: the chat so far, or a document and the questions about it. The memory for it is set aside in advance, so a shorter limit leaves more memory for the model itself, which makes a machine with little memory faster. The presets for a million tokens keep their own length.': 25,
  'Keep the hardware profile’s choice unless you need longer conversations, or want a little more speed on a 32 GB machine. Changing it restarts Outcrop (a few minutes).': 26,
  'As the hardware profile sets it (recommended)': 27,
  '131,072 tokens (about 100,000 words)': 28,
  '262,144 tokens (about 200,000 words)': 29,
  'The console password, whether answers are computed in full, and how long a conversation can be': 30,
} as const

/**
 * Plumbing. DO NOT EDIT.
 */
export type I18nKey = keyof typeof dict
export type LangDict = Record<(typeof dict)[I18nKey], string>
export default dict
