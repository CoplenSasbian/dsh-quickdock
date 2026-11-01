/**
 * Composer island for the input window.
 *
 * The dock's text box is drawn with the primitives the main window's composer
 * uses (Pill chips, Button), so the two windows share one look instead of
 * drifting apart. Behaviour stays with the page: the island owns the text and
 * the marks, and calls back — it never talks to the API itself.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Button, Pill } from '@deepseek-ai/dsh-client-ui-primitives'

const h = React.createElement

const KEYS = [
  { kind: 'permission', icon: '▣' },
  { kind: 'model', icon: '◈' },
  { kind: 'thinking', icon: '✦' },
  { kind: 'agent', icon: '◎' }
]

function Composer({ bridge }) {
  const inputRef = useRef(null)
  const [marks, setMarks] = useState({ permission: '', model: '', thinking: '', agent: '' })
  const [agentVisible, setAgentVisible] = useState(false)
  const [canSend, setCanSend] = useState(false)
  const [disabled, setDisabled] = useState(false)
  const api = useRef(null)

  /** Grow to the text, up to six lines, then scroll. */
  const grow = useCallback(() => {
    const node = inputRef.current
    if (!node) return
    node.style.height = 'auto'
    const line = 18
    node.style.height = Math.min(node.scrollHeight, line * 6 + 12) + 'px'
  }, [])

  api.current = {
    getValue: () => (inputRef.current ? inputRef.current.value : ''),
    setValue: (text) => {
      const node = inputRef.current
      if (!node) return
      node.value = text
      setCanSend(Boolean(text.trim()))
      grow()
    },
    clear: () => {
      const node = inputRef.current
      if (!node) return
      node.value = ''
      setCanSend(false)
      grow()
    },
    focus: () => {
      if (inputRef.current) inputRef.current.focus()
    },
    setMarks: (next) => {
      setMarks((prev) => ({ ...prev, ...next }))
      if (next.agentVisible !== undefined) setAgentVisible(Boolean(next.agentVisible))
    },
    setDisabled: (value) => setDisabled(Boolean(value)),
    canSend: () => Boolean(api.current.getValue().trim()) && !disabled
  }

  useEffect(() => {
    if (bridge.ready) bridge.ready(api.current)
    else bridge.api = api.current
  }, [bridge])

  const submit = useCallback(() => {
    const value = api.current.getValue().trim()
    if (!value || disabled) return
    bridge.onSubmit(value)
  }, [bridge, disabled])

  const onInput = useCallback(() => {
    setCanSend(Boolean(api.current.getValue().trim()))
    grow()
  }, [grow])

  const onKeyDown = useCallback((event) => {
    if (event.key !== 'Enter' || event.shiftKey) return
    // Enter during IME composition picks a candidate, it does not send.
    if (event.isComposing || event.keyCode === 229) return
    event.preventDefault()
    submit()
  }, [submit])

  return h('div', { className: 'qd-composer' },
    h('textarea', {
      ref: inputRef,
      className: 'qd-composer-input',
      rows: 1,
      maxLength: 100000,
      spellCheck: false,
      placeholder: bridge.placeholder || '',
      'aria-label': bridge.label || bridge.placeholder || 'Composer',
      onInput,
      onKeyDown,
      disabled
    }),
    h('div', { className: 'qd-composer-bar' },
      KEYS.map((key) => {
        if (key.kind === 'agent' && !agentVisible) return null
        return h(Pill, {
          key: key.kind,
          className: 'qd-key',
          onClick: (event) => bridge.onOpenMenu(key.kind, event.currentTarget),
          'aria-haspopup': 'menu',
          title: marks[key.kind] || ''
        },
        h('span', { className: 'qd-key-icon', 'aria-hidden': 'true' }, key.icon),
        h('span', { className: 'qd-key-text' }, marks[key.kind] || bridge.placeholderKey || '')
        )
      }),
      h('span', { className: 'qd-composer-spacer' }),
      h(Button, {
        variant: 'primary',
        size: 'sm',
        className: 'qd-send',
        disabled: !canSend || disabled,
        onClick: submit,
        title: bridge.sendTitle || 'Send',
        'aria-label': bridge.sendTitle || 'Send'
      }, '↑')
    )
  )
}

/**
 * Mount the composer into a host element.
 * @param {{host: HTMLElement, placeholder?: string, label?: string,
 *          sendTitle?: string, onSubmit: (text: string) => void,
 *          onOpenMenu: (kind: string, anchor: HTMLElement) => void}} options
 * @returns {{setValue: Function, getValue: Function, clear: Function,
 *            focus: Function, setMarks: Function, setDisabled: Function}}
 */
export function createComposer(options) {
  const host = options.host
  const bridge = {
    placeholder: options.placeholder || '',
    label: options.label || '',
    sendTitle: options.sendTitle || '',
    onSubmit: options.onSubmit,
    onOpenMenu: options.onOpenMenu,
    api: null,
    ready: (api) => { bridge.api = api }
  }
  host.classList.add('qd-composer-host')
  const root = createRoot(host)
  root.render(h(Composer, { bridge }))
  // The page talks to the live instance; before the first commit it is a stub.
  const forward = (name) => (...args) => {
    if (bridge.api) return bridge.api[name](...args)
    return undefined
  }
  return {
    setValue: forward('setValue'),
    getValue: forward('getValue'),
    clear: forward('clear'),
    focus: forward('focus'),
    setMarks: forward('setMarks'),
    setDisabled: forward('setDisabled')
  }
}
