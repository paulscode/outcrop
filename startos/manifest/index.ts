import { setupManifest } from '@start9labs/start-sdk'
import { long, short } from './i18n'

// One s9pk per architecture (the Makefile packs each with ARCH set): hardwareRequirements are per s9pk, and they differ.
// Unset (when StartOS evaluates the bundle on the server), it follows the CPU it runs on.
const arch: 'x86_64' | 'aarch64' =
  (process.env.ARCH ?? (process.arch === 'arm64' ? 'aarch64' : 'x86_64')) ===
  'aarch64'
    ? 'aarch64'
    : 'x86_64'

// What a machine needs to be offered Outcrop.  Sideloading ignores these: Outcrop's own profile check is the real gate.
const hardware = {
  x86_64: {
    arch: ['x86_64'],
    device: [
      {
        class: 'display' as const,
        vendor: null,
        product: '(?i)GM200',
        driver: 'nvidia',
        description:
          'A Quadro M6000 24 GB or Tesla M40 24 GB with the NVIDIA driver (startos-nvidia-legacy)',
      },
      {
        class: 'processor' as const,
        vendor: null,
        product: null,
        capabilities: ['avx2'],
        description: 'A CPU with AVX2 (Intel Haswell, AMD Zen or newer)',
      },
    ],
    ram: 30 * 1024 ** 3, // a "32 GB" machine reports 31.3 GiB
  },
  aarch64: {
    arch: ['aarch64'],
    device: [
      {
        class: 'display' as const,
        vendor: null,
        product: null,
        driver: 'nvidia',
        description: 'An NVIDIA GB10 with 128 GB of unified memory',
      },
    ],
    ram: 110 * 1024 ** 3,
  },
}

const image = {
  source: { dockerBuild: { dockerfile: './Dockerfile', workdir: '.' } },
  emulateMissing: false,
  nvidiaContainer: true,
}

export const manifest = setupManifest({
  id: 'outcrop',
  title: 'Outcrop',
  license: 'MIT',
  packageRepo: 'https://github.com/paulscode/outcrop',
  upstreamRepo: 'https://github.com/paulscode/outcrop',
  marketingUrl: 'https://github.com/paulscode/outcrop',
  donationUrl: null,
  description: { short, long },
  osVersion: '0.4.2.1',
  volumes: ['main', 'models', 'startos'],
  images: {
    main:
      arch === 'aarch64'
        ? { ...image, arch: ['aarch64'] }
        : { ...image, arch: ['x86_64'] },
  },
  hardwareAcceleration: true,
  hardwareRequirements: hardware[arch],
})
