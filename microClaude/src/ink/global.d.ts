import type { ReactNode, Ref } from 'react'
import type { DOMElement } from './dom.js'

type InkHostProps = {
  ref?: Ref<DOMElement | null>
  children?: ReactNode
  [key: string]: unknown
}

declare global {
  namespace JSX {
    interface IntrinsicElements {
      'ink-box': InkHostProps
      'ink-text': InkHostProps
      'ink-link': InkHostProps
      'ink-raw-ansi': InkHostProps
    }
  }
}

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'ink-box': InkHostProps
      'ink-text': InkHostProps
      'ink-link': InkHostProps
      'ink-raw-ansi': InkHostProps
    }
  }
}

export {}
