import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react';

function cx(...parts: (string | false | undefined | null)[]): string {
  return parts.filter(Boolean).join(' ');
}

/* --------------------------------------------------------------- button */

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
  loading?: boolean;
};

const BUTTON_VARIANTS: Record<string, string> = {
  primary:
    'bg-ember-500 text-ink-950 font-semibold hover:bg-ember-400 active:bg-ember-600 shadow-lg shadow-ember-600/20',
  secondary: 'bg-ink-700 text-ink-100 hover:bg-ink-600 border border-ink-600',
  ghost: 'text-ink-300 hover:text-ink-100 hover:bg-ink-800',
  danger: 'bg-red-900/70 text-red-100 hover:bg-red-800 border border-red-800',
};

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  className,
  children,
  disabled,
  // A bare <button> inside a <form> submits it, which reloads the page and
  // throws away where the user was. Submitting has to be asked for.
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled || loading}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-lg transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-arcane-400',
        'disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'px-3 py-1.5 text-sm' : 'px-4 py-2.5 text-sm',
        BUTTON_VARIANTS[variant],
        className,
      )}
    >
      {loading && (
        <span className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
      )}
      {children}
    </button>
  );
}

/* ---------------------------------------------------------------- input */

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-ink-200">{label}</span>
      {children}
      {error ? (
        <span className="mt-1.5 block text-sm text-red-400">{error}</span>
      ) : hint ? (
        <span className="mt-1.5 block text-sm text-ink-400">{hint}</span>
      ) : null}
    </label>
  );
}

const CONTROL =
  'w-full rounded-lg border border-ink-600 bg-ink-850 px-3 py-2.5 text-ink-100 placeholder:text-ink-500 ' +
  'transition-colors focus:border-arcane-400 focus:outline-none focus:ring-2 focus:ring-arcane-500/30';

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={cx(CONTROL, className)} />;
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...rest} className={cx(CONTROL, 'resize-y', className)} />;
}

/**
 * A text box with a dropdown of known answers attached.
 *
 * Deliberately not a `<select>`. Class, species and background are the fields
 * people reach for the list on nine times out of ten and type something the SRD
 * has never heard of on the tenth - a homebrew species, a multiclass string, a
 * background the table invented. A select forces an "Other…" escape hatch and a
 * second input; a datalist offers the list and still takes anything.
 */
export function Suggest({
  options,
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { options: readonly string[] }) {
  // Options are fixed reference lists, so the id is stable across renders.
  const listId = `suggest-${options.join('-').replace(/[^a-z]/gi, '').slice(0, 32)}`;

  return (
    <>
      <input {...rest} list={listId} className={className} />
      <datalist id={listId}>
        {options.map((option) => (
          <option key={option} value={option} />
        ))}
      </datalist>
    </>
  );
}

/* ----------------------------------------------------------------- misc */

export function Card({
  className,
  children,
  id,
}: {
  className?: string;
  children: ReactNode;
  id?: string;
}) {
  return (
    <div
      id={id}
      className={cx(
        'rounded-xl border border-ink-700 bg-ink-900/80 shadow-xl shadow-black/40 backdrop-blur',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function Alert({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-red-900/60 bg-red-950/50 px-3 py-2.5 text-sm text-red-200">
      {children}
    </div>
  );
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'dm' | 'player';
}) {
  const tones = {
    neutral: 'bg-ink-700 text-ink-200',
    dm: 'bg-ember-500/15 text-ember-300 border border-ember-500/30',
    player: 'bg-arcane-500/15 text-arcane-400 border border-arcane-500/30',
  };
  return (
    <span
      className={cx(
        'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium tracking-wide uppercase',
        tones[tone],
      )}
    >
      {children}
    </span>
  );
}

export function Spinner() {
  return (
    <div className="flex items-center justify-center p-12">
      <span className="size-8 animate-spin rounded-full border-3 border-ink-600 border-t-ember-500" />
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-dashed border-ink-700 px-6 py-14 text-center">
      <h3 className="font-display text-lg text-ink-100">{title}</h3>
      <p className="mx-auto mt-2 max-w-sm text-sm text-ink-400">{description}</p>
      {action && <div className="mt-5 flex justify-center">{action}</div>}
    </div>
  );
}
