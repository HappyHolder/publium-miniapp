import { cn } from '@/lib/utils'

interface SwitchProps {
  label: string
  description?: string
  value: boolean
  onChange: (v: boolean) => void
}

export function Switch({ label, description, value, onChange }: SwitchProps) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-white">{label}</p>
        {description && (
          <p className="text-[12px] text-[#66666E] mt-0.5">{description}</p>
        )}
      </div>
      <button
        type="button"
        onClick={() => onChange(!value)}
        aria-label={label}
        aria-checked={value}
        role="switch"
        className="relative ml-3 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF6A00]"
      >
        <span className={cn('relative block h-5 w-9 rounded-full transition-colors duration-200 motion-reduce:transition-none',value ? 'bg-[#FF6A00]' : 'bg-[#3A3A3F]')}>
        <span
          className={cn(
            'absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm',
            'transition-transform duration-200 motion-reduce:transition-none',
            value ? 'translate-x-4' : 'translate-x-0'
          )}
        />
        </span>
      </button>
    </div>
  )
}
