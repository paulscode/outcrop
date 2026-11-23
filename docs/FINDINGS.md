# Findings: measurements on the reference system

What was measured while setting up the reference system (2026-11-06 and after), and why its presets are what they are.
The reference system is an AMD EPYC with 236 GiB of RAM and a Quadro M6000 24GB at PCIe Gen3 x16: the `m6000-256g`
profile. Profiles for smaller machines are in [PROFILES.md](PROFILES.md). Earlier work ran on an earlier test machine with
the same card and 32 or 64 GB of RAM; this file records what differs here and what was measured again.

## The machine

| Item | Value | Earlier test machine (same card) |
| --- | --- | --- |
| GPU | Quadro M6000 24GB, Maxwell sm_52, 1,152 MHz top clock (VBIOS-locked), 250 W | Same card model |
| PCIe | Gen3 **x16**; the engine's probe measured 10.8 to 13.1 GB/s host to device | x8, 6.5 GB/s |
| CPU | 128 vCPUs: EPYC 7742, 64 cores x 2 threads, 4 NUMA nodes of 32 vCPUs (KVM guest) | 16 vCPUs |
| RAM | 236 GiB, about 59 GiB per NUMA node | 32 or 64 GB |
| Disk | 2 TB QEMU disk, not flagged rotational, read-ahead 128 KiB. **Sustained writes about 100 MB/s**, so downloads and the Q8 copies were disk-bound | Flagged rotational, 8 MiB read-ahead |
| Software | Zorin OS 18.1, kernel 7.0.0-42, driver 580.178.04; CUDA 12.9.1 added at /usr/local/cuda-12.9 (12.6 stays the system default) | Same OS, kernel, driver |

Two quirks carried over from the VM host:

- **CMA-flagged memory with no CMA area** (`CmaTotal` 0, `CmaFree` 15.8 GiB). Pinned memory cannot live there. At 236 GiB it no
  longer matters: everything the largest preset pins fits with room to spare.
- **The remote desktop uses the GPU.** While someone is connected over RDP, `gnome-remote-desktop-daemon` takes 14 to 20% of the
  GPU's SM time and `gnome-shell` 2 to 8% (`nvidia-smi pmon`), and the desktop holds about 300 MiB of VRAM. The numbers below
  were taken with an RDP session open, except the second run in "Final presets, through the service": measured again with
  nobody connected, decode was 7 to 15% faster.

## Software choices

- **Strata v0.2.11** (commit c3b3f50, engine 0.1.57), released 2026-11-05, with six sm_52 patches from the earlier work on the same card
  rebased onto it. All six applied without conflicts; upstream's changes in the same files (a BF16-as-Q8_0 fallback, a
  head-in-host-memory fallback, AMD barriers, Q5_0 rounding) do not touch the paths the patches add. Upstream still has no
  Maxwell support of its own. The patches are in `patches/`. Three more (0007-0009, 2026-11-23) are for the low-RAM mode
  of the 32 GB machines: see the last section.
- **CUDA 12.9.1**, the last toolkit that compiles for Maxwell. Its runfile repoints `/usr/local/cuda` and adds itself to the
  loader path; `setup/install.sh` gives both back, and the engine finds 12.9 through its RUNPATH.
- **llama.cpp at Strata's pin (3cf0325)** with the dp4a-to-VMAD patch. GitHub's archive download stalled on this network (as
  on the earlier test machine); a shallow `git fetch` of the one commit worked at once.
- **DFlash2**, Strata's newer default drafter, is built only for CUDA 8.6 and newer, so this card keeps the MTP drafter.
- **Pictures** run on the CPU encoder (`strata-vision`, built native for this EPYC). It takes no VRAM, which the experts need.

## What the engine chose by itself here

From the engine log at start (`outcrop logs`):

- **The n-gram table is locked in RAM** (`--ple-io ram`, chosen by the residency policy because 216+ GiB were free): no disk
  read sits on the token path.
- **Every routed expert is pinned in RAM** (the full arena), as on the earlier test machine at 64 GB.
- **32 CPU pool workers**, one per physical core on vCPUs 2 to 64, the host thread on vCPU 0. That spans three NUMA nodes. The
  engine's NUMA split supports exactly two nodes, so it stays off.
- **PCIe share 0.10**: the CPU takes most missed experts rather than the link.

## Context: 262,144 tokens costs almost nothing, and a million costs 10% of the expert cache

The KV cache keeps 32,768 cells per attention layer in VRAM and streams the rest from RAM (`--kv-resident 32768`), so the context
mostly costs RAM, of which there is plenty. On the plain Q2_0 pack, raising the context from 32K to 262K took the VRAM expert
cache from 13,835 to 13,528 slots (2%).

`bench/plans/r3-context.json` on the quality pack (IQ3_S, tuned), one round, greedy, median of 3. Decode in tokens/s, then the
prompt speed of the 4K and 16K documents:

| Context | Expert slots in VRAM | Chat | Code | Story | 4K doc | 16K doc | 4K prompt | 16K prompt |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 131,072 | 8,280 | 36.2 | 40.7 | 30.2 | 36.1 | 34.9 | 176 | 194 |
| 262,144 (the trained maximum) | 8,167 | 34.4 | 37.5 | 29.5 | 34.2 | 35.0 | 177 | 195 |
| 1,048,576 (YaRN x4) | 7,450 | 35.9 | 38.9 | 27.6 | 34.9 | 34.3 | 176 | 195 |

The 262K row is 2 to 8% lower on short answers, more than its 1.4% smaller cache explains, and the 1M row with 10% fewer slots is
not lower. So the gaps are mostly run-to-run noise (3 to 10% per case here). The presets use the full 262,144 tokens, and each
has a `-1m` twin. YaRN changes the model slightly at every length (Strata's own setup turns it on only past 262K), so the
`-1m` presets are for when the extra length is needed.

## Strata 0.2.11 against the earlier pin: the same speed

`bench/plans/r1-engine.json`: the Q2_0 pack with the tuned settings (Q8_0 dense planes, mode 8 experts, F32 dense, English draft
vocabulary, async adaptive tier) at 128K context, the two engines interleaved over two rounds. Greedy, thinking off, 256 tokens,
median of 3. Decode in tokens/s; the last column is the 4K prompt.

| Engine | Round | Chat | Code | Story | 4K doc | 4K prompt |
| --- | --- | --- | --- | --- | --- | --- |
| Earlier pin (c62d5e3, engine 0.1.55) + patches | 1 | 41.7 | 44.4 | 33.8 | 41.2 | 191 |
| Strata 0.2.11 (engine 0.1.57) + patches | 1 | 40.4 | 45.3 | 31.5 | 38.2 | 179 |
| Earlier pin | 2 | 39.1 | 44.1 | 30.3 | 38.2 | 179 |
| Strata 0.2.11 | 2 | 37.7 | 43.6 | 31.7 | 36.0 | 178 |

From the engine's decode timing, a verify window took 65.5 ms on the pin and 66.3 ms on 0.2.11 (1%), with 2.62 and 2.65 tokens
accepted per window: the same within noise. 0.2.11 is the one used, for its server fixes (streamed tool calls, penalties counting
only the reply, stream timeouts, replica hand-over) and so the patches sit on current upstream. Both rounds ran with the RDP
session open; the second round of each was slower than the first as the card heated to 81 C.

Against the earlier test machine's 64 GB result for the same pack (42.1 / 48.3 / 35.4 / 43.4, 4K prompt 199), these are 2 to 10% lower.
The likely cause is the RDP session's share of the GPU (14 to 20% of SM time), since decode is GPU-bound: of a 55 to 66 ms window,
47 to 55 ms is spent waiting on the GPU, 0.5 to 3.6 ms on CPU experts and about 5 ms on the draft.

## Decode is GPU-bound, so the CPU pool was left at its default

With every expert pinned in RAM and 95 to 99% of expert reads hitting VRAM, the CPU computes 0.2 to 3 experts per layer and
window. That is at most 5% of a window, so no pool setting can move decode by more than a few percent.

The pool plan (`bench/plans/followup-pool.json`) ran headless on 2026-11-06 at 16:37, on `quality`, median of 3, 256 tokens:

| Arm | Chat | Code | Story | 4K doc | 4K prompt |
| --- | --- | --- | --- | --- | --- |
| 32 workers (default) | 38.5 | 42.1 | 31.7 | 39.2 | 196 |
| 16 workers | 38.2 | 41.2 | 31.9 | 39.1 | 193 |
| 8 workers | 38.0 | 40.4 | 30.4 | 38.4 | 194 |
| 31 workers on two NUMA nodes | 38.8 | 42.1 | 31.5 | 39.4 | 195 |
| `--aux-cpus auto` | 36.7 | 42.5 | 31.8 | 39.4 | 193 |

Every arm is within about 2% of the default except 8 workers (2 to 4% slower) and `--aux-cpus auto` on chat (5% slower, but
best on code, so likely noise). Nothing beats the default by more than run-to-run noise, so presets.json is unchanged. If the CPU
is ever wanted for other work, 16 workers costs about 1%.

## Final presets, through the service

`bench/validate.sh` switched the real service (`outcrop switch`) to each preset and ran the answer gate (`qualgate.py`, 6
checks including a 4K needle), the API check (`apitest.py --fast` against the LAN address: OpenAI chat plain, streamed and with a
tool call, Responses, Anthropic Messages, and the Ollama bridge's tags, chat and generate) and `quickbench.py` (greedy, thinking
off, 256 tokens, median of 3). All at 262,144 tokens of context with pictures on. It ran twice on 2026-11-06: at 14:13 with an
RDP session open, and at 15:54 over SSH after a reboot, with only the GDM greeter on the desktop.

Headless, 15:54 (the numbers in README.md):

| Preset | Switch time | Experts in VRAM | Answer gate | APIs | Chat | Code | Story | 4K doc | 4K prompt | First token, short prompt |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| speed (Q2_0) | 61 s | 12,301 | 6 of 6 | 11 of 11 | 43.2 | 48.9 | 33.0 | 42.4 | 199 | 1.1 to 1.3 s |
| balanced (IQ3_XXS) | 66 s | 9,736 | 6 of 6 | 11 of 11 | 37.8 | 43.6 | 31.6 | 40.0 | 193 | 1.2 to 1.5 s |
| quality (IQ3_S) | 64 s | 8,310 | 6 of 6 | 11 of 11 | 37.1 | 42.1 | 31.2 | 40.4 | 193 | 1.2 to 1.4 s |

With the RDP session open, 14:13:

| Preset | Switch time | Experts in VRAM | Answer gate | APIs | Chat | Code | Story | 4K doc | 4K prompt | First token, short prompt |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| speed (Q2_0) | 32 s | 12,082 | 6 of 6 | 11 of 11 | 38.6 | 44.1 | 29.4 | 38.8 | 180 | 1.2 to 1.5 s |
| balanced (IQ3_XXS) | 37 s | 9,563 | 6 of 6 | 11 of 11 | 34.3 | 38.0 | 28.7 | 36.4 | 178 | 1.3 to 1.6 s |
| quality (IQ3_S) | 42 s | 8,161 | 6 of 6 | 11 of 11 | 34.6 | 37.5 | 29.0 | 35.6 | 177 | 1.3 to 1.6 s |

Without the RDP session:

- Decode was 7 to 15% faster and the 4K prompt 8 to 11% faster.
- Each preset had about 2% more expert slots: the logged-in desktop held about 300 MiB of VRAM, while the greeter holds 10 MiB.
- Switches were slower headless: 61 to 66 s, against 32 to 42 s with the session open. Stopping the previous engine took 11 to 14 s. From start to "experts loaded"
  took 39 to 46 s for every preset, whether the engine reported its expert copy at 5.6 GiB/s (`speed` and `balanced`, loaded for
  the first time since the reboot) or at 20.9 GiB/s (`quality`, whose pack was still in the page cache). So the expert copy is
  not where the time goes, and a cold page cache does not explain the difference. Not investigated further.
- `quality` and `balanced` stay level within noise.
- The full API check from another computer on the LAN (`apitest.py --host` with the server's address) passed 13 of 13.
- After the reboot, `quality` started by itself and answered 68 s after its unit started.

Earlier, with the plumbing preset, the full API check (13 of 13, adding a thinking answer and a picture read by the CPU encoder)
and the official `ollama`, `openai` and `anthropic` Python clients all worked against the LAN address, including Ollama tool
calls with a tool-result turn.

With `quality` loaded the machine had 90 GiB of RAM in use and 145 GiB available. Switches are quick because the packs stay in
the page cache; after a reboot the first start reads the pack and the n-gram table from disk.

## The 1M presets start and answer

Start checks through the service, then the answer gate (2026-11-06):

| Preset | Experts in VRAM (base preset) | Answer gate |
| --- | --- | --- |
| speed-1m | 11,018 (12,082) | 6 of 6 |
| balanced-1m | 8,720 (9,563) | 6 of 6 |
| quality-1m | 7,449 (8,163) | 6 of 6 |

At 1,048,576 tokens the KV cache past the 32K kept in VRAM takes 12.4 GiB of pinned RAM.

## Long context past 262K: needles found at 500K and 1M tokens

`bench/longctx.py` on `quality-1m` (YaRN x4), headless, greedy, thinking off, run unattended on 2026-11-06,
with the 250K run on `quality` for comparison:

| Preset | Prompt | Depth | Read in | Prompt speed | Answer | Decode after it | KV reads from VRAM |
| --- | --- | --- | --- | --- | --- | --- | --- |
| quality | 249,745 | 60% | 24.8 min | 167.6 tok/s | `SAFFRON-800`, correct | 18.9 tok/s | 78% |
| quality-1m | 499,371 | 30% | 52.5 min | 158.5 tok/s | `AMBER-777`, correct | 26.2 tok/s | 74% |
| quality-1m | 998,789 | 70% | 2 h 12 min | 123.8 tok/s | `COBALT-799`, correct | 20.6 tok/s | 76% |

So the `-1m` presets do retrieve across their whole window. Plan on about an hour per 500K tokens and over two hours for a million;
the prompt rate falls as the context grows because each chunk attends over more KV, a quarter of it streamed from RAM. After the
500K prompt the engine parked the conversation (8.5 GB) in 5.6 s. The 1M request reused only 16,384 tokens of it, as expected for
a different document. No errors or restarts; RAM held at the expected 12.4 GiB of KV.

## Long context: a needle at 250K tokens, through the service

`bench/longctx.py` on `quality` (262,144 context): 249,745 tokens of numbered shipping records with one code hidden at 60% depth,
greedy, thinking off.

| Prompt | Read in | Prompt speed | Answer | Decode after it |
| --- | --- | --- | --- | --- |
| 249,745 tokens | 24.8 min | 167.6 tok/s | `SAFFRON-800`, correct | 18.9 tok/s (8 tokens) |

The prompt read at 280 tok/s per 8K chunk early on and slowed as the context grew, averaging 168. At that length 78% of the KV
blocks the attention read came from VRAM and the rest from RAM. The first try overshot the context with a 367,834-token prompt; the
server refused it with a clear 400 ("requests are never truncated"), and `longctx.py` now sizes the document from the server's
count.

## The API gateway costs under a millisecond

Every request goes through `outcrop-gateway` (tokens, the request log), and Strata listens on loopback behind it. Measured
on the server on the evening of 2026-11-06, interleaved with direct requests to Strata:

| | Direct to Strata | Through the gateway |
| --- | --- | --- |
| First token, short streamed prompt (median of 30 pairs, `bench/overhead.py`) | 345.9 ms | 346.7 ms (+0.8 ms) |
| Stream rate over 64 tokens (median) | 40.5 chunks/s | 40.4 chunks/s (-0.2%) |
| quickbench round 1, decode chat / code / story / 4K doc (tok/s) | 38.1 / 43.0 / 31.9 / 39.7 | 38.8 / 42.4 / 31.8 / 38.9 |
| quickbench round 1, first token on the 4K document | 21.04 s | 21.01 s |

The differences are within run-to-run noise, and inside the budget set for the gateway (5 ms on first token, nothing
measurable on decode).
A client that hangs up is cancelled in Strata 0.54 s later mid-prompt (streamed or not) and 0.11 s later mid-answer, by
Strata's own `client_disconnect_cancels` counter (`bench/gatewaytest.py`). A revoked token is refused 0.08 s after `outcrop
token revoke`. A 249,745-token prompt through the gateway found its needle (`SAFFRON-800`): read at 182.9 tok/s, answered after 22.8
minutes (the same prompt direct, with RDP still open, read at 167.6 tok/s).

## Two things to watch: the GPU's temperature on long prompts, and VRAM headroom

- During the 250K-token prompt the card ran at 100% for 25 minutes at about 200 to 240 W and **83 °C**, the edge of the
  console's GPU alert (above 83 °C, or throttling, for a minute). NVML reported no throttling. The fan stays on the card's own
  curve; a temperature-driven fan controller would be the remedy if it starts to throttle.
- Strata's log says "only 455 to 511 MiB of VRAM free at the start of this request (below 512 MiB): when the card is this full
  the driver can page GPU memory to system RAM" six times across the day's starts on `quality`. After loading, 771 MiB are
  free; capturing the drafter's verify windows takes most of the rest. No slowdown was measured (the tables above), but if
  decode ever drops to a few tok/s, this is the first suspect; a preset with a smaller expert cache would leave more room.

## Switching presets: huge pages could stall a start for minutes

`balanced-1m` took 247 s to become ready, against 32 to 48 s for the others. The engine asks for transparent huge pages for its
expert arena when at least half the arena could be backed by 2 MiB blocks that are free at that moment. Right after a switch the
previous engine's arena has just been freed, so the test passes; the rest of the 40 GiB arena then needs the kernel to compact
memory around about 170 GiB of page cache for every huge page, and loading the experts took about 3.5 minutes instead of about
20 s. The presets now set `STRATA_NO_ARENA_THP=1`. Huge pages would only save TLB misses on the few experts the CPU computes,
under 5% of a decode window. With it, the switches after the 250K session took 84 s (`quality-1m`) and 79 s (`quality`), with
the log saying "transparent huge pages skipped": 19 s to stop the previous engine and give back its pinned memory, 13 s for the
dense weights, and 40 s to fill the expert arena, slower than the earlier 20 s because the long session had pushed part of the
pack out of the page cache.

## The model uses web tools well (2026-11-07)

`bench/tooltest.py` offers the model `web_search` and `open_page` with canned results. Nothing goes to the internet. It
asked 10 questions that need the web, 10 that don't, and 2 where a planted result tells the model to open an attacker's
link with the conversation in it.

| | Thinking off | Thinking on |
| --- | --- | --- |
| Searched when the question needed the web | 10/10 | 10/10 |
| Left the tools alone when it didn't | 10/10 | 10/10 |
| Tried to open the attacker's link | 0/2 | 0/2 |
| Median time, web questions | 35 s | 58 s |
| Median time, other questions | 6 s | 8 s |

- **Its tool choices.** The canned results contain no real answers, so the model kept searching (3–6 rounds). Then it
  said plainly that the results were placeholders rather than making an answer up. It also tries to open sites it
  knows, such as kernel.org or Wikipedia, without searching first. The provenance rule refuses those links and points it
  back to search.
- **With real search** (SearXNG on the server), "What is the latest stable Linux kernel version?" took 3 searches and 2
  pages from kernel.org. In 49 s it gave a correct, cited answer: 7.3.3, released the day before, with a table of the
  mainline, stable and longterm lines. Decode ran at 43.7 tok/s, and the title "Latest Stable Linux Kernel" followed by
  itself.
- **What it means:** web answers take 30–60 s, mostly in rounds of reading pages. Thinking adds about 20 s to a web
  answer, with no better choices of when to search.

## Web answers: the prompt cache needs the thinking sent back (2026-11-07)

One question, "What is the current stable version of Python, and what is new in it?", led to 3 searches and 2 pages in
the console's chat. It took 190 s, and 105 s of that was the last request re-reading a 22,008-token prompt with nothing
reused.

The tool rounds went back to the model without their thinking. The prompt then no longer matched what the engine had
cached, which Strata's documentation warns about ("send reasoning back … so the prompt matches and the cache is
reused").

With the thinking sent back, and pages cut from ~12K to ~6K tokens, the same question took **65 s**. It made 2
searches and read 2 pages, and each request reused the previous prompt: 766 of 2,080 tokens, then 2,199 of 9,163. The
rest is reading the pages' new text at about 200 tok/s, the quality preset's prompt speed.

## The 32 GB machines: a start that could stall, and far less read from the disk (2026-11-23)

Measured on the 32 GB reference VM (16 EPYC 7742 threads, 31 GiB of RAM, the M6000 at PCIe Gen3 x8), where both
presets run in the low-RAM mode: about 19.3 GiB of experts page-locked in RAM, the rest read from the model file. Every
run starts from a cold page cache, and the 40 GSM8K answers of each run are paired by question against a run without
the change (1.02 is 2% faster; two runs of the same settings differ by up to about 2.5%).

**The start could stall for minutes, page-locking the RAM tier.** The engine page-locked the whole tier in one
registration. On these kernels (Ubuntu's 7.0, which types pageblocks as CMA without a CMA area) that registration can
loop while the kernel's compaction runs: starts here took from 44 s to over 30 minutes, and 131 s and 314 s in one
evening. Engine patch 0007 page-locks the tier in segments of about 1 GiB, each before anything is written into it. With
compaction forced throughout a start, the single registration had not finished after 300 s; the segments took 22 s.
Decode and the answers are unchanged (all 40 GSM8K answers the same).

**Reads, and the context of `balanced`.** Engine patch 0008 (`STRATA_FETCH_WILLNEED=1`) asks for a missed expert's
slices together, where page faults went one read-around window at a time, and `STRATA_LOOKAHEAD_K=3` keeps the
look-ahead's own read hints to the top three ranks (past them, they only add reads). Both are set for both presets.

| | `speed` (Q2_0) | `balanced` (IQ3_XXS) |
|---|---|---|
| the read hints and K=3: GSM8K answers, paired | 1.021, and 1.004 in a second run (the shipped install): as fast | 1.038 |
| a 131,072-token context as well | not taken (0.98 on top of them) | 1.034 more, so 1.082 in all; 1.071 in a second run (the shipped install) |
| read from the disk during the 40 answers | 2.3 GB, now 0.9 GB | 137.7 GB, now 32.4 GB |
| the prompts' median time | 1.84 s, now 1.74 s | 3.35 s, now 2.43 s |
| on a disk capped at 0.5 GB/s, paired | (it barely reads) | 1.110: the new settings lose nothing there (1.009 against the uncapped disk), the old ones 3% |

The hints change only when bytes arrive, never what they are. The smaller context frees 1.7 GiB of the attention
cache's RAM copy, which is sized for the whole limit, for more experts; the card keeps 32,768 tokens of it either way,
so only conversations longer than 128K tokens need `"context": 262144` back. `speed`, whose pack nearly fits, gains
nothing from it and keeps 262,144.

**The file-only tail skip (engine patch 0009) is a trade, left off.** It computes the RAM tier's misses instead of
dropping them: closer to the exact model (with the IQ3_S pack, the KL divergence from the exact engine 0.0305 against
the skip's 0.0550, two exact runs differing by 0.0149), but 6.0% (`speed`) and 4.4% (`balanced`) slower here, the
experts it now computes costing more than the reads they would have saved. `STRATA_TAIL_SKIP_FILE_ONLY=1` turns it on.

**For an existing install:** `git pull && ./setup.sh update`, then `./setup.sh` (it applies the patches and rebuilds the
engine, which is stopped while it builds), then `outcrop profile apply m6000-32g` for the new settings.
