# Outcrop

Outcrop runs Qwen3.8-Flash-Next on your server's NVIDIA card and serves it to your apps on your home network.

## Before you start

- **The NVIDIA driver.** On a Quadro M6000 or Tesla M40, install [startos-nvidia-legacy](https://github.com/paulscode/startos-nvidia-legacy) first; the standard StartOS NVIDIA edition does not support these cards.
- **Disk space.** The first start downloads about 110 GB (32 GB of RAM) to 170 GB (64 GB or more) of model files, then prepares them. This takes from one hour to several, depending on your internet. The **Models** health check shows what it is doing. Interrupted downloads resume where they stopped.

## First steps

1. Run **Console password** to see the console's password (it was chosen at random when Outcrop was installed). The
   copy button copies it without showing it. **Configure** changes it.
2. Open the **Web console** and sign in with that password. It works while the models download.
3. In the console's **Connect** page, make a token for each app. It shows the exact settings to enter.

## Connecting apps

| App speaks | Address | The token goes in |
| --- | --- | --- |
| OpenAI (Open WebUI, Continue, n8n, the `openai` SDK...) | the **OpenAI and Anthropic API** address, with `/v1` | the API key field |
| Anthropic (Claude Code, the `anthropic` SDK) | the same address, without `/v1` | `ANTHROPIC_AUTH_TOKEN` |
| Ollama (Home Assistant, Obsidian plugins...) | the **Ollama API** address | an `Authorization: Bearer <token>` header |

These two addresses are plain HTTP on your home network (`http://YOUR-SERVER.local:8080` and `:11434`), as most apps expect. Apps that can trust StartOS's certificate can use **OpenAI and Anthropic API (HTTPS)** instead.

## Good to know

- One request is answered at a time; others wait their turn.
- Switching presets (in the console) takes about a minute with 64 GB of RAM, and about ten with 32 GB.
- Backups keep your settings, tokens and chats, not the models: after a restore they are downloaded again.
