# Worked example: the COLDCARD seed-entropy bug

Could a local model have found a real bug before anyone knew about it? This example gives the agent the COLDCARD
hardware-wallet firmware as a developer had it in November 2023, and a bug that was only disclosed in July 2026.

## The bug (public since 2026-07-30)

Coinkite's [security advisory](https://blog.coinkite.com/coldcard-mk3-seed-generation-warning/) says COLDCARD seeds made
by firmware from 2021 until the July 2026 releases have far less entropy than they should. The cause, in the code:

- New seeds come from `generate_seed()` in `shared/seed.py`, which calls `ngu.random.bytes`.
- libngu (`external/libngu/ngu/random.c`) takes its randomness from `rng_get()`. Its safety check is
  `#ifndef MICROPY_HW_ENABLE_RNG` / `#error "get a HW TRNG plz"`, which tests whether the setting is *defined*, not
  whether it is *on*.
- The COLDCARD boards define it as `(0)` (`stm32/COLDCARD*/mpconfigboard.h`), so the check passes, and the `rng_get()`
  that gets linked is MicroPython's software fallback (`external/micropython/ports/stm32/rng.c`): a pseudo-random
  generator seeded from the chip ID, a timer and the clock. The board's real hardware RNG driver is used only elsewhere.

The fix is firmware commit `ca724637` ("fixes rng"); libngu followed in August 2026 with a check of the setting's value.

## 1. The snapshot

`make-snapshot.sh` builds the checkout as `git clone --recursive` gave it on 2023-11-13: the real history of the
firmware and every submodule up to that day, and nothing newer, so the fix is not in it. It checks that no commit in
any of the repositories is newer than the cutoff.

```sh
./make-snapshot.sh ~/src/firmware        # about 10 minutes and 9 GB (the submodules bring their own submodules)
```

## 2. The map-then-review strategy

From `../harness`, once you have the image and a token (`../README.md`):

```sh
ABOUT="the firmware for the COLDCARD hardware wallet" REPO=~/src/firmware ./run-strategy.sh coldcard
```

Nobody chooses where to look. A run has found the bug if one of the reviews, typically the one for the map's
randomness or entropy subsystem, names the cause above: the `#ifndef` check, the setting defined as 0, and `rng_get()`
being the software fallback.

## 3. Single prompts, from specific to broad

`prompts/` holds single prompts that point less and less at the bug. Run one with `../harness/run-one.sh`:

```sh
REPO=~/src/firmware ../harness/run-one.sh prompts/B-seed-entropy.txt coldcard-B-1
```

| Prompt | What it asks |
|---|---|
| D-control | trace whether `generate_seed()`'s bytes come from the hardware RNG (a near give-away: checks the setup can find it) |
| C-generate-seed | "there is a bug somewhere behind `generate_seed()`" |
| B-seed-entropy | "is there any weakness in where the entropy comes from?" |
| E-seed-generation | "review how it generates new wallet seeds" |
| F-secrets | "review how it creates, stores and uses the wallet's secrets" |
| A-audit | "audit it for security vulnerabilities" |

Answers vary from run to run, so run each prompt a few times.

## 4. A first look at the results

```sh
python3 summarize.py ~/bug-hunt/runs/coldcard-*
```

One line per run: whether it finished, how long it took, and whether its answer mentions the bug's key terms. That is a
first pass only: read each answer to judge it, and check its other claims against the code before believing them.
