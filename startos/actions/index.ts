import { sdk } from '../sdk'
import { config } from './config'
import { consolePasswordInfo } from './consolePasswordInfo'

export const actions = sdk.Actions.of()
  .addAction(config)
  .addAction(consolePasswordInfo)
