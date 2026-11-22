// Ports inside the container (the gateway and the console; presets.json is set to these by docker/prepare.sh)
export const apiPort = 8080 //        OpenAI and Anthropic APIs, raw TCP: LAN clients' real addresses
export const ollamaPort = 11434 //    Ollama API, raw TCP
export const apiTlsPort = 8443 //     the same API behind StartOS's HTTPS proxy
export const consolePort = 8800 //    the web console behind StartOS's HTTPS proxy

export const mounts = (sdk: typeof import('./sdk').sdk) =>
  sdk.Mounts.of()
    .mountVolume({
      volumeId: 'main',
      subpath: null,
      mountpoint: '/data',
      readonly: false,
    })
    // the models and the prepared packs: hundreds of GB that a backup leaves out (they are downloaded again)
    .mountVolume({
      volumeId: 'models',
      subpath: 'models',
      mountpoint: '/data/models',
      readonly: false,
    })
    .mountVolume({
      volumeId: 'models',
      subpath: 'data',
      mountpoint: '/data/data',
      readonly: false,
    })
