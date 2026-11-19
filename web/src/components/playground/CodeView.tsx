import { Link } from '@tanstack/react-router'
import { Code2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { codeViews } from '@/lib/playground'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/controls'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { CopyButton } from '@/components/ui/misc'

/** "View as code": the exact request the next message makes, as curl, Python or JavaScript, with $TOKEN in place of a token. */
export function CodeView({ body, baseUrl, disabled }: { body: Record<string, unknown> | null; baseUrl: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  const views = useMemo(() => (open && body ? codeViews(body, baseUrl) : null), [open, body, baseUrl])
  const tabs: Array<{ id: 'curl' | 'python' | 'js'; label: string }> = [
    { id: 'curl', label: 'curl' },
    { id: 'python', label: 'Python' },
    { id: 'js', label: 'JavaScript' },
  ]
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" disabled={disabled || !body}>
          <Code2 aria-hidden /> <span className="hidden sm:inline">View as code</span>
          <span className="sm:hidden">Code</span>
        </Button>
      </DialogTrigger>
      <DialogContent wide>
        <DialogHeader>
          <DialogTitle>The request, as code</DialogTitle>
          <DialogDescription>
            The exact request your next message makes, sent to the gateway like any app. Put a token in{' '}
            <code className="rounded bg-panel-2 px-1 text-xs text-fg">TOKEN</code> first: make one on{' '}
            <Link to="/connect" className="link" onClick={() => setOpen(false)}>
              Connect
            </Link>
            .
          </DialogDescription>
        </DialogHeader>
        {views ? (
          <Tabs defaultValue="curl">
            <TabsList>
              {tabs.map((t) => (
                <TabsTrigger key={t.id} value={t.id}>
                  {t.label}
                </TabsTrigger>
              ))}
            </TabsList>
            {tabs.map((t) => (
              <TabsContent key={t.id} value={t.id} className="mt-3">
                <div className="relative">
                  <pre className="max-h-[52vh] overflow-auto rounded-lg border border-line bg-sunken/70 p-3.5 pr-12 font-mono text-[12px] leading-relaxed text-fg/90 scrollbar-thin">
                    {views[t.id]}
                  </pre>
                  <span className="absolute right-2 top-2">
                    <CopyButton value={views[t.id]} label={`Copy the ${t.label} code`} toastText={`Copied the ${t.label} code`} />
                  </span>
                </div>
              </TabsContent>
            ))}
          </Tabs>
        ) : null}
        {views?.shortened ? (
          <p className="text-xs text-faint">
            {views.shortened} picture{views.shortened === 1 ? ' is' : 's are'} shortened here; the real request carries them whole.
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
