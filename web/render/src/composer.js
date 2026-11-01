/**
 * Composer island for the input window.
 *
 * The layout mirrors DSH's own composer (ui-conversation InputBar): one card
 * surface, the text, then a row whose left cluster holds the borderless selects
 * and whose right end holds the round primary button. The styles live in
 * page.css, copied from InputBar.module.css so the two windows drift together.
 *
 * Behaviour stays with the page: the island owns the text and calls back.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'

const h = React.createElement

/** Left cluster in order of importance; the agent mark only exists for a new session. */
const MARKS = ['permission', 'model', 'thinking', 'agent']

function Composer({ bridge }) {
  const inputRef = useRef(null)
  const [marks, setMarks] = useState({ permission: '', model: '', thinking: '', agent: '' })
  const [agentVisible, setAgentVisible] = useState(false)
  const [canSend, setCanSend] = useState(false)
  const [disabled, setDisabled] = useState(false)
  const api = useRef(null)

  /** Grow with the text: DSH's composer does the same up to a cap. */
  const grow = useCallback(() => {
    const node = inputRef.current
    if (!node) return
    node.style.height = 'auto'
    node.style.height = Math.min(node.scrollHeight, 24 * 6 + 12) + 'px'
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
    setDisabled: (value) => setDisabled(Boolean(value))
  }

  // The page keeps a handle to the live instance for setMarks/clear/focus.
  useEffect(() => {
    bridge.api = api.current
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
    h('div', { className: 'qd-composer-row' },
      h('div', { className: 'qd-marks' },
        MARKS.map((kind) => {
          if (kind === 'agent' && !agentVisible) return null
          return h('button', {
            key: kind,
            type: 'button',
            className: 'qd-mark',
            onClick: (event) => bridge.onOpenMenu(kind, event.currentTarget),
            'aria-haspopup': 'menu',
            title: marks[kind] || ''
          }, marks[kind] || '')
        })
      ),
      h('div', { className: 'qd-trailing' },
        h('button', {
          type: 'button',
          className: 'qd-send',
          disabled: !canSend || disabled,
          onClick: submit,
          title: bridge.sendTitle || 'Send',
          'aria-label': bridge.sendTitle || 'Send'
        }, '↑')
      )
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
    api: null
  }
  host.classList.add('qd-composer-host')
  createRoot(host).render(h(Composer, { bridge }))
  const forward = (name) => (...args) => (bridge.api ? bridge.api[name](...args) : undefined)
  return {
    setValue: forward('setValue'),
    getValue: forward('getValue'),
    clear: forward('clear'),
    focus: forward('focus'),
    setMarks: forward('setMarks'),
    setDisabled: forward('setDisabled')
  }
}
