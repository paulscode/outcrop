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
  // actions and init
  'Set console password': 10,
  'Make a new console password (six random words). It is shown once; every console session is signed out.': 11,
  'Replaces the current console password and signs everyone out.': 12,
  'Console sign-in': 13,
  'Keep the password in your password manager: it is shown only now.': 14,
  'User name': 15,
  Password: 16,
  'Set a console password before signing in': 17,
} as const

/**
 * Plumbing. DO NOT EDIT.
 */
export type I18nKey = keyof typeof dict
export type LangDict = Record<(typeof dict)[I18nKey], string>
export default dict
