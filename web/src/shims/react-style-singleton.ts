// A stand-in for react-style-singleton (used by react-remove-scroll-bar, which Radix dialogs use to lock the page's scroll).
// The original adds a <style> element at runtime, which the console's CSP (style-src 'self') forbids.  The rules live in
// styles.css instead (body[data-scroll-locked] …; the lock attribute is still set by react-remove-scroll-bar), and the one
// dynamic value, the width of the scrollbar it hides, is set on <body> through the CSSOM, which the CSP allows.
// vite.config.ts aliases the package to this file.

import { useEffect } from 'react'

type Props = { styles: string; dynamic?: boolean }

let users = 0

export function styleSingleton() {
  return function Style({ styles }: Props) {
    useEffect(() => {
      const gap = /--removed-body-scroll-bar-size:\s*([\d.]+)px/.exec(styles)?.[1] ?? '0'
      users++
      document.body.style.setProperty('--removed-body-scroll-bar-size', `${gap}px`)
      return () => {
        users--
        if (users <= 0) document.body.style.removeProperty('--removed-body-scroll-bar-size')
      }
    }, [styles])
    return null
  }
}

export function styleHookSingleton() {
  return function useStyle(_styles: string, _isDynamic?: boolean) {}
}

export function stylesheetSingleton() {
  return { add(_style: string) {}, remove() {} }
}
