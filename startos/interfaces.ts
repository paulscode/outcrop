import { i18n } from './i18n'
import type { I18nKey } from './i18n/dictionaries/default'
import { sdk } from './sdk'
import { apiPort, apiTlsPort, consolePort, ollamaPort } from './utils'

export const setInterfaces = sdk.setupInterfaces(async ({ effects }) => {
  const iface = (
    id: string,
    name: I18nKey,
    description: I18nKey,
    type: 'ui' | 'api',
    plain: boolean,
  ) =>
    sdk.createInterface(effects, {
      name: i18n(name),
      id,
      description: i18n(description),
      type,
      masked: false,
      schemeOverride: plain ? { ssl: null, noSsl: 'http' } : null,
      username: null,
      path: '',
      query: {},
    })

  // The web console, behind StartOS's HTTPS proxy (StartOS's certificate)
  const consoleOrigin = await sdk.MultiHost.of(effects, 'console').bindPort(
    consolePort,
    { protocol: 'http' },
  )

  // The APIs on plain HTTP at their usual ports, raw TCP: StartOS publishes these on the LAN as they are, so apps keep
  // http://<server>.local:8080/v1 and :11434, and the gateway sees each app's own address (its tokens can be limited to
  // addresses).  Outcrop's tokens guard them, as on Ubuntu.
  const raw = {
    protocol: null,
    secure: { ssl: false },
    addSsl: null,
    proxy: null,
  } as const
  const apiOrigin = await sdk.MultiHost.of(effects, 'api').bindPort(apiPort, {
    ...raw,
    preferredExternalPort: apiPort,
  })
  const ollamaOrigin = await sdk.MultiHost.of(effects, 'ollama').bindPort(
    ollamaPort,
    {
      ...raw,
      preferredExternalPort: ollamaPort,
    },
  )
  // The same OpenAI/Anthropic API over HTTPS, for apps that can trust StartOS's certificate
  const apiTlsOrigin = await sdk.MultiHost.of(effects, 'api-tls').bindPort(
    apiTlsPort,
    { protocol: 'http' },
  )

  return [
    await consoleOrigin.export([
      iface(
        'console',
        'Web console',
        'Watch, chat, manage presets, tokens and security',
        'ui',
        false,
      ),
    ]),
    await apiOrigin.export([
      iface(
        'openai',
        'OpenAI and Anthropic API',
        'For apps: base URL with /v1 (OpenAI) or without (Anthropic); a token from the console',
        'api',
        true,
      ),
    ]),
    await ollamaOrigin.export([
      iface(
        'ollama',
        'Ollama API',
        'For apps that speak Ollama; a token from the console',
        'api',
        true,
      ),
    ]),
    await apiTlsOrigin.export([
      iface(
        'openai-tls',
        'OpenAI and Anthropic API (HTTPS)',
        "The same API with StartOS's certificate",
        'api',
        false,
      ),
    ]),
  ]
})
