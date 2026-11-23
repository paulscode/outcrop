import { sdk } from '../sdk'
import { check } from './check'
import { config } from './config'
import { consolePasswordInfo } from './consolePasswordInfo'
import { profile } from './profile'

export const actions = sdk.Actions.of()
  .addAction(config)
  .addAction(consolePasswordInfo)
  .addAction(check)
  .addAction(profile)
