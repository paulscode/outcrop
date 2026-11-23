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
    // the models and the prepared packs: hundreds of GB that a backup leaves out (they are downloaded again).  Beside the
    // data volume, never inside it: a mount inside another volume's mountpoint shows through in that volume's own folder,
    // and with StartOS's shared, recursive bind mounts each new subcontainer then doubled them (0.1.0.0: after about 16
    // subcontainers, a start failed with "move_mount: No space left on device").  $OUTCROP_HOME/models and data are links
    // to these (docker/prepare.sh).
    .mountVolume({
      volumeId: 'models',
      subpath: 'models',
      mountpoint: '/mnt/models',
      readonly: false,
    })
    .mountVolume({
      volumeId: 'models',
      subpath: 'data',
      mountpoint: '/mnt/data',
      readonly: false,
    })
