import { createStore } from '@/lib/store'

/** Whether the ⌘K palette is open (outside its lazy chunk, so the shortcut works before it loads). */
export const paletteStore = createStore(false)
