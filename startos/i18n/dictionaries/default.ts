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
} as const

/**
 * Plumbing. DO NOT EDIT.
 */
export type I18nKey = keyof typeof dict
export type LangDict = Record<(typeof dict)[I18nKey], string>
export default dict
