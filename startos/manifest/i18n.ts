export const short = {
  en_US: 'A capable LLM on budget, upgradable hardware',
}

const common =
  'engine, and serves it to your apps on your home network with the OpenAI, Anthropic and Ollama APIs, each app with ' +
  'its own access token. A web console shows what it is doing, lets you chat with it, and manages it all. '

// one description per s9pk: the hardware, the download and the driver differ by architecture
export const long = {
  x86_64: {
    en_US:
      'Outcrop runs Qwen3.8-Flash-Next (125B parameters) on a Quadro M6000 24 GB or Tesla M40 24 GB through the Strata ' +
      common +
      'The first start downloads about 110 to 170 GB of model files. Needs the NVIDIA driver from startos-nvidia-legacy.',
  },
  aarch64: {
    en_US:
      'Outcrop runs Qwen3.8-Flash-Next (125B parameters) on an NVIDIA GB10 with 128 GB of unified memory (DGX Spark, ' +
      'ASUS Ascent GX10 and similar) through the Strata ' +
      common +
      'The first start downloads about 85 GB of model files.',
  },
}
