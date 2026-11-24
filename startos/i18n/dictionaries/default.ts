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
  'To save time, the engine leaves out the smallest contributions to each word when they would have to be fetched from RAM or the disk. In our tests this changed how answers were worded, more often than not, but not how many were right. On computes every word in full, exactly as the model would, and answers come more slowly when the machine reads from its disk: measured 3 to 6% slower with 32 GB of RAM, and about 1% with plenty of RAM.': 20,
  'Off is faster, and is what we recommend. On gives exactly what the full model would write, more slowly. Changing it restarts Outcrop (a few minutes).': 21,
  'Off: faster (recommended)': 22,
  'On: slower, every answer computed in full': 23,
  'Longest conversation': 24,
  'How much one conversation can hold: the chat so far, or a document and the questions about it. The memory for it is set aside in advance, so a shorter limit leaves more memory for the model itself, which makes a machine with little memory faster. The presets for a million tokens keep their own length.': 25,
  'Keep the hardware profile’s choice unless you need longer conversations, or want a little more speed on a 32 GB machine. Changing it restarts Outcrop (a few minutes).': 26,
  'As the hardware profile sets it (recommended)': 27,
  '131,072 tokens (about 100,000 words)': 28,
  '262,144 tokens (about 200,000 words)': 29,
  'The console password, whether answers are computed in full, how long a conversation can be, and which models to keep': 30,
  'Models to keep': 47,
  'Each preset runs a model pack of 80 to 110 GB. Keeping every pack the hardware profile offers lets you switch between its presets in a minute or two. Keeping only the boot preset’s pack fits a smaller disk (about 120 GB for the speed preset): only that preset runs, and choosing another boot preset downloads its pack at the next start and deletes the old one. Outcrop chooses this by itself when the disk is too small for every pack.': 48,
  'Keep every pack unless the disk is small. A change takes effect when Outcrop starts next: it restarts now.': 49,
  'Every pack the hardware profile offers (recommended)': 50,
  'Only the boot preset’s: less disk, one preset at a time': 51,
  // actions/check.ts
  'Check answers and speed': 31,
  'Asks the model six questions with known answers, then times two short pieces of writing. Takes about a minute; for seeing what a change under Configure did.': 32,
  'The model did not answer: is the engine still starting? See the Engine health check, then try again.': 33,
  'answers right': 34,
  'Writing speed in tokens per second (a token is about three quarters of a word):': 35,
  'The check stopped part way, after': 44,
  'answers (the engine may still be settling after a start): try again in a minute.': 45,
  // actions/profile.ts
  'Update hardware settings': 36,
  'Takes the settings for your kind of machine (its hardware profile): the newest ones, which an update of Outcrop may have improved, or after you added RAM or changed the GPU, those of the profile that fits it now. Your choices under Configure, the boot preset and the network settings are kept.': 37,
  'If there is anything new, Outcrop restarts to use it (a few minutes, or longer when a bigger profile needs a model pack downloaded). Changes made to the presets in the web console’s editor are replaced by the profile’s; a copy of the old file is kept.': 38,
  'Already up to date: nothing new in the hardware profile': 39,
  'Updated to the newest settings of the hardware profile': 40,
  'Outcrop is restarting to use them.': 41,
  'Outcrop uses them when it starts.': 42,
  'What changed is below.': 43,
  'Changed the hardware profile from': 52,
  to: 53,
  'It downloads': 54,
  'when Outcrop starts; the Models health check shows the progress.': 55,
  // hardware.ts
  'Outcrop keeps only one model pack': 56,
  'Outcrop moved to a smaller hardware profile': 57,
  // utils.ts
  'This check has not finished after one minute': 46,
} as const

/**
 * Plumbing. DO NOT EDIT.
 */
export type I18nKey = keyof typeof dict
export type LangDict = Record<(typeof dict)[I18nKey], string>
export default dict
