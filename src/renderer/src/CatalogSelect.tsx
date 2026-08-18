import { Check, ChevronDown } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'

export interface CatalogSelectOption {
  value: string
  label: string
}

interface CatalogSelectProps {
  ariaLabel: string
  value: string
  options: CatalogSelectOption[]
  onChange(value: string): void
}

export function CatalogSelect({
  ariaLabel,
  value,
  options,
  onChange
}: CatalogSelectProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  const selected = options.find((option) => option.value === value) ?? options[0]

  useEffect(() => {
    if (!open) return undefined
    const closeOutside = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', closeOutside)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('pointerdown', closeOutside)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  return (
    <div className="catalog-select" ref={rootRef}>
      <button
        type="button"
        className="catalog-select-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{selected?.label ?? ''}</span>
        <ChevronDown aria-hidden="true" />
      </button>
      {open && (
        <div className="catalog-select-menu" id={listId} role="listbox" aria-label={ariaLabel}>
          {options.map((option) => (
            <button
              type="button"
              className={
                option.value === value
                  ? 'catalog-select-option catalog-select-option--selected'
                  : 'catalog-select-option'
              }
              role="option"
              aria-selected={option.value === value}
              key={option.value}
              onClick={() => {
                onChange(option.value)
                setOpen(false)
              }}
            >
              <span>{option.label}</span>
              {option.value === value && <Check aria-hidden="true" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
