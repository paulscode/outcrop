# Hardware profiles

Outcrop is made for a class of budget, upgradable machines: a used 24 GB Maxwell card (the Quadro M6000) in a
workstation or server with 32 GB of RAM or more. The same model runs differently with 32 GB than with 256 GB: what fits
in RAM, which packs are worth downloading, how much RAM the caches may take. A **hardware profile** holds those choices.

`./setup.sh` reads the GPU and the RAM, suggests a profile, and makes `~/.outcrop/presets.json` from it. Everything
after that (the engine, the gateway, the console) reads presets.json.

```sh
outcrop profile                 # this machine's GPU, RAM and disk, and the profile that fits
outcrop profile list            # all profiles, with the ones that fit marked
outcrop profile show m6000-32g  # what a profile offers and why
outcrop profile diff m6000-64g  # what applying it would change in presets.json
outcrop profile apply m6000-64g # do it (the old presets.json is kept as a .bak copy)
```

## The profiles

| Profile | RAM | Packs | Boot default | Tested |
| --- | --- | --- | --- | --- |
| `m6000-32g` | 24 to 47 GB | Q2_0, IQ3_XXS | `speed` | yes, on a 32 GB machine (2026-11-18) |
| `m6000-64g` | 48 to 95 GB | Q2_0, IQ3_XXS, IQ3_S | `balanced` | yes, with RAM held to 64 GB (2026-11-18) |
| `m6000-128g` | 96 to 191 GB | Q2_0, IQ3_XXS, IQ3_S, and the 1M-token presets | `quality` | not yet |
| `m6000-256g` | 192 GB and more | as 128g, with a bigger conversation cache | `quality` | the reference system ([FINDINGS.md](FINDINGS.md)) |
| `gb10-128g` | 110 to 139 GB, unified | IQ3_S | `quality` (262K context) | yes, on an ASUS Ascent GX10 under StartOS (2026-11-22) |

Each profile's `"tested"` field says on what machine and when it was checked; `null` means not yet. The Tesla M40 24 GB
is the same chip as the M6000 and is listed as similar: setup suggests the matching profile with a note that it has not
been tested on that card.

The GB10 (DGX Spark, ASUS Ascent GX10) is a different kind of machine: an Arm CPU and the GPU share one 128 GB memory.
Its profile runs Strata's own Spark settings, with the experts read in place from the model file (`ram_mode: mmap`) and
no second copy for the CPU. Only IQ3_S is offered, because the other packs' CPU kernels are x86-only.

What changes with RAM, and why:

- **Which packs.** A pack runs fastest when every expert stays pinned in RAM ("full" mode). That needs about 42 GiB free
  for Q2_0, 50 for IQ3_XXS and 57 for IQ3_S. With less, the engine keeps the most used experts in RAM and reads the
  rest from the model file ("low-RAM" mode): Q2_0 holds its speed there, IQ3_XXS slows down as other programs take RAM,
  and IQ3_S is not worth it. The mode is chosen each time a preset starts, from the RAM free at that moment.
- **The conversation cache.** Strata parks recent conversations in RAM, so returning to a long one (or an agent
  switching between its helpers) does not read the whole prompt again. 2 parked conversations in 4 GiB at 32 and 64 GB,
  up to 16 in 48 GiB on the reference system.
- **The 1M-token presets.** Beyond 262K tokens of context, the attention cache past what stays in VRAM is pinned in RAM:
  about 12 GiB at a million tokens, on top of the experts. Only the 128g and 256g profiles offer them.

## What a profile file holds

A profile is a JSON file in [profiles/](../profiles/): a presets.json template, plus a `"profile"` block about the
profile itself.

```json
{
  "profile": {
    "name": "m6000-32g",
    "extends": "m6000-base",
    "title": "Quadro M6000 24 GB with 32 GB of RAM",
    "match": {"gpus": ["Quadro M6000 24GB"], "similar_gpus": ["Tesla M40 24GB"], "vram_mib_min": 23000, "ram_gib": [24, 48]},
    "packs": ["q2_0", "iq3_xxs"],
    "default_preset": "speed",
    "tested": "when and on what",
    "notes": ["shown by outcrop profile show and ./setup.sh"]
  },
  "common": {"args": ["--adapt-async 1", "--conversation-cache-mib 4096", "--conversation-cache-slots 2"]},
  "presets": {
    "speed": {"description": "...", "pack": "q2_0", "context": 262144}
  }
}
```

**The profile block:**

| Field | Meaning |
| --- | --- |
| `name` | The file's name without `.json` |
| `extends` | Another profile this one builds on. Objects merge key by key; anything else (lists, numbers, strings) is replaced; `null` removes a key |
| `abstract` | `true` for a profile that is only for extending (`m6000-base`): never suggested or applied |
| `title`, `about`, `notes` | Shown by `outcrop profile show` and `./setup.sh` |
| `match.gpus` | GPU names as `nvidia-smi` prints them, that the profile was made for |
| `match.similar_gpus` | GPUs of the same family: suggested with a "not tested on this card" note |
| `match.vram_mib_min` | Less VRAM than this and the profile does not fit |
| `match.ram_gib` | `[low, high)`: the RAM sizes the profile is for, in GiB as the system reports it |
| `match.arch` | CPU architectures, as `uname -m` prints them (`aarch64`); any when absent |
| `match.memory` | `discrete` (the default: the GPU has its own VRAM) or `unified` (one memory for both, as on a GB10) |
| `packs` | The model packs setup downloads and prepares: `q2_0`, `iq3_xxs`, `iq3_s`, `iq2_xs` |
| `default_preset` | The preset started at boot |
| `tested` | When and on what machine it was checked, or `null` |

**Everything else is presets.json:**

| Section | Holds |
| --- | --- |
| `server` | Where Strata listens (loopback behind the gateway), the model name apps see |
| `gateway` | The API gateway's ports and limits |
| `console` | The console's ports |
| `engine` | The engine binary in `~/.outcrop/bin` |
| `common` | `q8_dense` (`false` skips the CPU's Q8 copy of the dense weights, which a unified-memory machine does not use), `ram_mode`, `env` (engine switches, `STRATA_*` and a few thread settings only) and `args` (engine flags) for every preset; `vision` (`cpu`, `gpu` or `off`; `gpu` needs a CUDA build of the encoder, as on the GB10) and `vision_cfg` (`max_tokens`, `threads`, and `elastic`: `false` keeps a GPU encoder loaded instead of starting it with the first picture) |
| `presets` | One entry per preset: `description`, `pack`, `context`, and optionally `rope` (`{"scaling": "yarn", "scale": 4}`), `kv`, `kv_resident`, `ram_mode` (`auto`, `full`, `resident`, `mmap`), `expert_cache`, `prefill`, `mtp`, `spec`, `env`, `args`, `drop_env`, `engine`, `vision`, and the server options `parallel`, `sampling`, `reasoning_effort`, `max_tokens`, `idle_unload_s` |

When a profile is applied, the `server`, `gateway` and `console` sections of an existing presets.json are kept: those are
this machine's network choices, not the profile's.

The engine refuses settings that could make it run another program or load a library: environment variables other than
the engine's own switches, and flag values with paths in them. The console's preset editor applies the same rules.

## A profile for your machine

A different amount of RAM, another card from the same family, a different disk: if a profile almost fits, a new one is
usually a short file that extends `m6000-base` or one of the RAM profiles.

1. Copy the closest profile to `profiles/<gpu>-<ram>.json` and change its `name`, `title` and `match`.
2. Change what your machine needs: packs, presets, the conversation cache in `common.args`, contexts.
3. `outcrop profile show NAME` and `outcrop profile diff NAME` check it reads as you mean; `outcrop profile apply NAME`
   and `outcrop restart` try it.
4. Measure: `outcrop bench` (decode speed) and `outcrop test` (answer quality) on each preset, and a few real requests.
5. Set `tested` to what you ran it on, and send a pull request with the numbers ([CONTRIBUTING.md](../CONTRIBUTING.md)).

A different GPU family (another architecture, other VRAM sizes) needs more: the engine is built for Maxwell (`sm_52`)
with patches in [patches/](../patches/), and the engine switches in `m6000-base` were chosen by measurement on that
card. Open an issue first; it is very welcome.
