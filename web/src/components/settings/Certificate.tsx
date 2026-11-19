import { useQueryClient } from '@tanstack/react-query'
import { Download, Fingerprint, LockKeyhole, ShieldCheck, ShieldQuestion, TriangleAlert } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Switch, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/controls'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Badge, CopyButton, KV, Skeleton } from '@/components/ui/misc'
import { api, ApiError } from '@/lib/api'
import { day, device, int } from '@/lib/format'
import { qk, useServerState, useTls } from '@/lib/queries'
import { Callout, SettingsSection } from './Section'

type Os = 'macos' | 'ios' | 'android' | 'windows' | 'linux' | 'firefox'

function guessOs(): Os {
  const d = device(typeof navigator !== 'undefined' ? navigator.userAgent : '')
  if (d.startsWith('Firefox')) return 'firefox'
  if (d.endsWith('iOS')) return 'ios'
  if (d.endsWith('Android')) return 'android'
  if (d.endsWith('macOS')) return 'macos'
  if (d.endsWith('Windows')) return 'windows'
  return 'linux'
}

function Steps({ items }: { items: React.ReactNode[] }) {
  return (
    <ol className="grid gap-2.5 text-[13px] leading-relaxed">
      {items.map((t, i) => (
        <li key={i} className="flex gap-3">
          <span className="num flex size-6 shrink-0 items-center justify-center rounded-full border border-line-strong bg-panel-2 text-xs text-fg">
            {i + 1}
          </span>
          <span className="min-w-0 pt-0.5 text-muted">{t}</span>
        </li>
      ))}
    </ol>
  )
}

function Cmd({ children }: { children: string }) {
  return (
    <span className="mt-1.5 flex items-start gap-2">
      <code className="num block min-w-0 flex-1 overflow-x-auto whitespace-pre rounded-md border border-line bg-sunken px-2.5 py-1.5 text-xs text-fg scrollbar-thin">
        {children}
      </code>
      <CopyButton value={children} label="Copy the command" />
    </span>
  )
}

const b = (s: string) => <strong className="font-medium text-fg">{s}</strong>

export function CertificateSection() {
  const qc = useQueryClient()
  const { data: tls, isPending } = useTls()
  const { data: st } = useServerState()
  const [os, setOs] = useState<Os>(guessOs)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const https = !!st?.console.https
  const hsts = !!st?.console.hsts
  const host = st?.host ?? 'computer'
  const file = `${host}-ca.crt`
  const name = tls?.ca_subject?.replace(/^CN=/, '').split(',')[0] ?? `${host} CA`

  const setHsts = async (on: boolean) => {
    setBusy(true)
    try {
      await api.put('/api/settings/hsts', { enabled: on })
      void qc.invalidateQueries({ queryKey: qk.state })
      toast.success(on ? 'HSTS is on' : 'HSTS is off', {
        description: on ? 'Browsers that visit now will only use HTTPS here for a year.' : 'Browsers that saw it keep it until it expires.',
      })
      setConfirm(false)
    } catch (e) {
      toast.error('Changing HSTS failed', { description: e instanceof ApiError ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  const steps: Record<Os, React.ReactNode[]> = useMemo(
    () => ({
      macos: [
        <>Download the certificate ({file}) and double-click it. Keychain Access opens; add it to the {b('System')} keychain.</>,
        <>Find “{name}” in System, double-click it, open {b('Trust')} and set “When using this certificate” to {b('Always Trust')}.</>,
        <>Close the window and enter your Mac’s password. Safari and Chrome trust it at once; Firefox has its own steps.</>,
      ],
      ios: [
        <>Open this page in {b('Safari')} and download the certificate; allow the configuration profile.</>,
        <>Settings → General → {b('VPN & Device Management')} → the downloaded profile → Install.</>,
        <>Settings → General → About → {b('Certificate Trust Settings')} → turn on full trust for “{name}”.</>,
      ],
      android: [
        <>Download the certificate ({file}).</>,
        <>Settings → Security → Encryption & credentials → {b('Install a certificate')} → {b('CA certificate')} → Install anyway.</>,
        <>Pick the file. Chrome trusts it; other apps decide for themselves.</>,
      ],
      windows: [
        <>Download the certificate and double-click it → {b('Install Certificate')} → Current User.</>,
        <>Choose “Place all certificates in the following store” → {b('Trusted Root Certification Authorities')} → Finish.</>,
        <>
          Or in PowerShell:
          <Cmd>{`Import-Certificate -FilePath .\\${file} -CertStoreLocation Cert:\\CurrentUser\\Root`}</Cmd>
        </>,
      ],
      linux: [
        <>
          Debian and Ubuntu:
          <Cmd>{`sudo cp ${file} /usr/local/share/ca-certificates/ && sudo update-ca-certificates`}</Cmd>
        </>,
        <>
          Fedora:
          <Cmd>{`sudo cp ${file} /etc/pki/ca-trust/source/anchors/ && sudo update-ca-trust`}</Cmd>
        </>,
        <>
          Chrome and Chromium keep their own list:
          <Cmd>{`certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n "${name}" -i ${file}`}</Cmd>
        </>,
      ],
      firefox: [
        <>Download the certificate.</>,
        <>Settings → Privacy & Security → Certificates → {b('View Certificates')} → Authorities → {b('Import')}.</>,
        <>Pick the file and tick “Trust this CA to identify websites”.</>,
      ],
    }),
    [file, name],
  )

  return (
    <SettingsSection
      id="certificate"
      title="Certificate and HTTPS"
      icon={LockKeyhole}
      meta={https ? 'this page is on HTTPS' : 'this page is on plain HTTP'}
      description="The console and the API use HTTPS with a private certificate authority that can only vouch for this server’s own names, on the LAN. Install the CA’s certificate once on each device, and the browser trusts the console with no warning."
    >
      {isPending ? (
        <Skeleton className="h-32" />
      ) : !tls?.ca ? (
        <Callout tone="neutral" icon={ShieldQuestion} title="No certificate authority yet">
          The console runs on plain HTTP here. <code className="rounded bg-panel-2 px-1 text-xs">setup/install-console.sh</code> creates
          the private CA (name-constrained to this server) and the console’s certificate; then this page offers it for download.
        </Callout>
      ) : (
        <div className="grid gap-5">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto]">
            <KV
              rows={[
                ['Authority', <span>{name}</span>],
                [
                  'Fingerprint',
                  <span className="flex items-start gap-2">
                    <Fingerprint className="mt-0.5 size-3.5 shrink-0 text-faint" aria-hidden />
                    <span className="num min-w-0 break-all text-xs leading-relaxed text-fg">{tls.ca_fingerprint}</span>
                    {tls.ca_fingerprint ? <CopyButton value={tls.ca_fingerprint} label="Copy the fingerprint" size="xs" /> : null}
                  </span>,
                ],
                ['Valid until', <span className="num">{tls.ca_not_after ? day(Date.parse(tls.ca_not_after) / 1000) : '—'}</span>],
                [
                  'Server certificate',
                  <span>
                    <span className="num">{tls.server_not_after ? day(Date.parse(tls.server_not_after) / 1000) : '—'}</span>
                    {typeof tls.days_left === 'number' ? (
                      <Badge tone={tls.days_left < 14 ? 'warn' : 'neutral'} className="ml-2">
                        {int(tls.days_left)} days left
                      </Badge>
                    ) : null}
                    <span className="mt-0.5 block text-xs text-faint">Renewed by a timer before it runs out</span>
                  </span>,
                ],
                [
                  'Names',
                  <span className="flex flex-wrap gap-1">
                    {(tls.server_names ?? []).map((n) => (
                      <Badge key={n} className="num">
                        {n}
                      </Badge>
                    ))}
                  </span>,
                ],
              ]}
            />
            <div className="flex flex-col gap-2 lg:items-end">
              <Button asChild variant="primary">
                <a href="/ca.crt" download={file}>
                  <Download /> Download the certificate
                </a>
              </Button>
              <span className="num text-xs text-faint">{file}</span>
            </div>
          </div>

          <div className="grid gap-3">
            <h3 className="text-[13px] font-semibold text-fg">Install it on a device</h3>
            <Tabs value={os} onValueChange={(v) => setOs(v as Os)}>
              <TabsList aria-label="Device">
                <TabsTrigger value="macos">macOS</TabsTrigger>
                <TabsTrigger value="ios">iPhone, iPad</TabsTrigger>
                <TabsTrigger value="android">Android</TabsTrigger>
                <TabsTrigger value="windows">Windows</TabsTrigger>
                <TabsTrigger value="linux">Linux</TabsTrigger>
                <TabsTrigger value="firefox">Firefox</TabsTrigger>
              </TabsList>
              {(Object.keys(steps) as Os[]).map((k) => (
                <TabsContent key={k} value={k} className="pt-4">
                  <Steps items={steps[k]} />
                </TabsContent>
              ))}
            </Tabs>
            <p className="text-xs text-faint">
              Check that the fingerprint your device shows matches the one above before you trust it.
            </p>
          </div>
        </div>
      )}

      <div className="mt-6 flex items-start gap-3 border-t border-line pt-5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <ShieldCheck className="size-4 text-faint" aria-hidden />
            <span id="hsts-label" className="text-[13px] font-medium text-fg">
              Always use HTTPS (HSTS)
            </span>
            {hsts ? <Badge tone="ok">on</Badge> : null}
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            {https
              ? 'Tells every browser that visits to use only HTTPS here for a year, so nobody on the LAN can downgrade it to plain HTTP. Turn it on once the certificate is installed on every device you use.'
              : 'Available when you open the console over HTTPS with the certificate installed. On a plain-HTTP page it does nothing, and turned on too early it would lock out devices that do not trust the certificate yet, for a year.'}
          </p>
        </div>
        <Switch
          checked={hsts}
          disabled={!https || busy}
          onCheckedChange={(v) => (v ? setConfirm(true) : void setHsts(false))}
          aria-labelledby="hsts-label"
        />
      </div>

      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <div className="mb-2 flex size-9 items-center justify-center rounded-lg border border-line-strong bg-panel-2">
              <TriangleAlert className="size-4 text-warn" aria-hidden />
            </div>
            <DialogTitle>Turn on HSTS?</DialogTitle>
            <DialogDescription>
              Every browser that visits from now on refuses plain HTTP here for a year, even if you turn it off again. A device that
              does not trust the certificate yet cannot open the console until it does. Install the certificate everywhere first.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              Not yet
            </Button>
            <Button variant="primary" onClick={() => setHsts(true)} loading={busy}>
              Turn on HSTS
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsSection>
  )
}
