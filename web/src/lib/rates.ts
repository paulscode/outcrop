// The overview chart's rates, one line per writing phase, from the 1 s metrics samples.

import { engineWords } from './engine'
import type { MetricsSample } from './types'

export interface PhaseRates {
  think: Array<number | null>
  answer: Array<number | null>
}

/**
 * Tokens per second while thinking and while answering, one value per sample (null where the engine was in another
 * phase, so each line has gaps). Reading the prompt is left out on purpose: it runs several times faster, and its tall
 * blocks drowned out the detail in the other two.
 */
export function phaseRates(samples: MetricsSample[]): PhaseRates {
  const think: Array<number | null> = []
  const answer: Array<number | null> = []
  for (const s of samples) {
    const k = engineWords(s.engine).key
    think.push(k === 'thinking' ? (s.engine.tok_s ?? null) : null)
    answer.push(k === 'answering' ? (s.engine.tok_s ?? null) : null)
  }
  return { think, answer }
}
