# Outcrop on StartOS

Outcrop runs on [StartOS](https://start9.com) 0.4.2.1 and later as a service you install from the StartOS marketplace
(the paulscode registry) or by sideloading its `.s9pk`. This page says what you need, what the first start does, and
what is different from an install on Ubuntu with `./setup.sh`.

## What you need

| | |
| --- | --- |
| GPU | Quadro M6000 24 GB, or Tesla M40 24 GB (the same chip, not tested yet) |
| Driver | [startos-nvidia-legacy](https://github.com/paulscode/startos-nvidia-legacy): StartOS's own NVIDIA edition supports only newer cards |
| CPU | x86-64 with AVX2 (Intel Haswell, AMD Zen and newer) |
| RAM | 32 GB or more (see "Memory" below) |
| Disk | about 120 GB (32 GB of RAM) to 180 GB (64 GB and more) free for the service |

StartOS offers Outcrop only to servers with such a GPU, CPU and RAM. A sideloaded package installs anywhere, but its
engine starts only on hardware a [profile](PROFILES.md) fits; the **Engine** health check says why when it does not.

## Install and first start

1. Install Outcrop. It chooses a random console password; the **Console password** action shows it (masked, with a
   copy button), and **Configure** changes it.
2. Start the service. The first start downloads the model files for your hardware profile, checks them, and prepares
   them: about 110 GB with 32 GB of RAM, from about half an hour to several hours depending on your internet. The
   **Models** health check shows the file it is on. An interrupted download resumes where it stopped.
3. While it downloads, open the **Web console**, sign in with that password, and make a token for each app
   on the **Connect** page. When the models are ready the engine starts by itself; the **Engine** health check says
   when it answers.

## Connecting apps

| Interface (in StartOS) | Address | Use |
| --- | --- | --- |
| OpenAI and Anthropic API | `http://YOUR-SERVER.local:8080` | OpenAI apps add `/v1`; Anthropic apps use it as it is |
| Ollama API | `http://YOUR-SERVER.local:11434` | Ollama apps |
| OpenAI and Anthropic API (HTTPS) | the HTTPS address StartOS shows | apps that can trust StartOS's root certificate |
| Web console | the HTTPS address StartOS shows | your browser |

Every app needs a token, as on Ubuntu. The two plain-HTTP API ports are the ones most apps expect, and on them Outcrop
sees each app's own address, so a token can be limited to the address of the device that uses it.

## What is different from Ubuntu

- **Security of the server itself** (firewall, SSH, updates) is StartOS's. The console's Security page checks only what
  Outcrop secures: tokens, the API, the console's HTTPS.
- **HTTPS** for the console comes from StartOS, with StartOS's certificate. There is no `http://YOUR-SERVER.local/ca`
  page: trust StartOS's root CA on your devices instead (StartOS's own docs show how).
- **No desktop**: `outcrop desktop` and the console's certificate commands are for Ubuntu servers.
- **Memory.** StartOS keeps a share of the RAM for itself and starts reclaiming its services' memory at about 90% of
  the rest. Outcrop stays below that line, so it has a few GiB less than on Ubuntu: about 25 GiB of 32 GB, and about
  52 GiB of 64 GB. With 64 GB, the `quality` preset therefore runs in low-RAM mode, reading some of its model from
  disk, where on Ubuntu it would hold it all in RAM; a fast SSD matters more.
- **Other services share that line.** StartOS draws one memory line for all of its services together. Outcrop sizes
  itself from what is free when a preset starts; a service that grows afterwards can push everything past the line,
  and then every service slows to a crawl. With 32 GB, give Outcrop the server to itself, or keep the other services
  small.
- **Locked memory.** StartOS does not let a service lock more than 8 MiB of RAM. Outcrop works without it, and the
  engine's GPU transfers are not affected; a few percent of speed may be lost.
- **Backups** keep your settings, tokens, chats and logs, not the models (hundreds of GB). After a restore they are
  downloaded again on the next start.
- **The command line**: `outcrop` works inside the service, for example from the server over SSH:
  `sudo start-cli package attach outcrop --name outcrop --user outcrop -- outcrop status`.

## Updating

Install the new version from the marketplace, or sideload it. The models are kept; only what changed is applied.
