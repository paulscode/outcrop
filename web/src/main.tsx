import '@fontsource-variable/inter/wght.css'
import '@fontsource-variable/jetbrains-mono/wght.css'
import 'sonner/dist/styles.css'
import './styles.css'

import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Toaster } from 'sonner'
import { ReauthHost } from './components/shell/Reauth'
import { TooltipProvider } from './components/ui/menu'
import { setUnauthorizedHandler } from './lib/api'
import { live, resetLive } from './lib/live'
import { queryClient } from './lib/queries'
import { initTheme, useResolvedTheme } from './lib/theme'
import { watchForUpdates } from './lib/version'
import { router } from './router'

initTheme()

function goSignIn() {
  if (location.pathname.startsWith('/signin')) return
  resetLive()
  queryClient.clear()
  const next = location.pathname + location.search
  void router.navigate({ to: '/signin', search: { next: next !== '/' ? next : undefined } })
}
setUnauthorizedHandler(goSignIn)
live.setSignoutHandler(goSignIn)
watchForUpdates()

function Toasts() {
  const theme = useResolvedTheme()
  return (
    <Toaster
      theme={theme}
      position="bottom-right"
      closeButton
      toastOptions={{
        classNames: {
          toast: '!bg-panel-3 !border-line-strong !text-fg !rounded-lg !shadow-xl',
          description: '!text-muted',
          title: '!font-medium',
        },
      }}
    />
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={250} skipDelayDuration={100}>
        <RouterProvider router={router} />
        <ReauthHost />
        <Toasts />
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
)
