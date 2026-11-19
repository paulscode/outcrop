import { useNavigate, useSearch } from '@tanstack/react-router'
import { CorsPanel, ModePanel, TokenlessPanel } from '@/components/access/ModePanel'
import { MigrationPanel, TokensPanel } from '@/components/access/Tokens'

export default function Access() {
  const search = useSearch({ strict: false }) as { token?: string; new?: string }
  const navigate = useNavigate()
  return (
    <div className="grid gap-4">
      <ModePanel />
      <TokensPanel
        openId={search.token}
        newOpen={!!search.new}
        onCloseDetail={() => navigate({ to: '/access', search: {}, replace: true })}
        onCloseNew={() => search.new && navigate({ to: '/access', search: {}, replace: true })}
      />
      <MigrationPanel />
      <div className="grid gap-4 lg:grid-cols-2">
        <TokenlessPanel />
        <CorsPanel />
      </div>
    </div>
  )
}
