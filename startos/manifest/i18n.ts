export const short = {
  en_US: 'A capable LLM on budget, upgradable hardware',
}

// One description for both architectures: the registry refuses a version whose s9pks differ in anything but their
// hardware requirements ("package metadata mismatch").
export const long = {
  en_US:
    'Outcrop runs Qwen3.8-Flash-Next (125B parameters) through the Strata engine, on a Quadro M6000 24 GB or Tesla M40 ' +
    '24 GB (x86-64), or on an NVIDIA GB10 with 128 GB of unified memory (DGX Spark, ASUS Ascent GX10 and similar). It ' +
    'serves it to your apps on your home network with the OpenAI, Anthropic and Ollama APIs, each app with its own ' +
    'access token. A web console shows what it is doing, lets you chat with it, and manages it all. The first start ' +
    'downloads about 110 to 170 GB of model files (about 85 GB on a GB10). An M6000 or M40 needs the NVIDIA driver ' +
    'from startos-nvidia-legacy; a GB10 uses the driver StartOS includes.',
}
