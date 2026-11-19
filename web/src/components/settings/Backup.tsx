import { Archive, Download, KeyRound } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { ApiError, download } from '@/lib/api'
import { Callout, SettingsSection } from './Section'

/** A backup of the console's database (tokens, settings, history), optionally with its secrets. */
export function BackupSection() {
  const [busy, setBusy] = useState<'plain' | 'secrets' | null>(null)
  const get = async (secrets: boolean) => {
    setBusy(secrets ? 'secrets' : 'plain')
    try {
      const ok = await download(`/api/backup?secrets=${secrets ? 1 : 0}`, `outcrop-backup${secrets ? '-with-secrets' : ''}.tar.gz`)
      if (ok) toast.success('The backup is downloading', { description: secrets ? 'It holds the keys: keep it like a password.' : 'Without secrets: rotate the tokens after a restore.' })
    } catch (e) {
      toast.error('The backup failed', { description: e instanceof ApiError ? e.message : String(e) })
    } finally {
      setBusy(null)
    }
  }
  return (
    <SettingsSection
      id="backup"
      title="Backup"
      icon={Archive}
      description="The console's database as a .tar.gz: tokens (as keyed hashes), settings, the request log, events and history. Restore it with outcrop console restore."
    >
      <div className="grid gap-4">
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => get(false)} loading={busy === 'plain'}>
            <Download /> Download a backup
          </Button>
          <Button variant="warn-outline" onClick={() => get(true)} loading={busy === 'secrets'}>
            <KeyRound /> With secrets
          </Button>
        </div>
        <Callout tone="neutral" title="Without secrets or with them?">
          Without secrets, a restored server needs every token rotated (apps get new values). With secrets it includes the token
          pepper, the internal key and the CA key, so keep that file like a password. Both ask for your password again.
        </Callout>
      </div>
    </SettingsSection>
  )
}
