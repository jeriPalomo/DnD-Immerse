import { useEffect, useRef, useState, type FormEvent } from 'react';
import { DICE_LIMITS, DIE_TYPES, validateExpression, type RollMode } from '@dnd/shared';
import { Button } from './ui.js';
import { useTable } from '../store/table.js';
import { useAuth } from '../store/auth.js';
import type { WireCard, WireChatMessage } from '@dnd/shared';

export function ChatPanel() {
  const { messages, members, connected, send, roll, cardAction, error } = useTable();
  const { user } = useAuth();

  const [draft, setDraft] = useState('');
  const [whisperTo, setWhisperTo] = useState<string | null>(null);
  const [secret, setSecret] = useState(false);
  const [inputError, setInputError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;

    setInputError(null);

    // A leading / means "roll this": /1d20+5, or /r 2d6.
    if (text.startsWith('/')) {
      const expression = text.replace(/^\/(r|roll)?\s*/i, '');
      const check = validateExpression(expression);
      if (!check.ok) {
        setInputError(check.reason ?? 'Not a dice expression');
        return;
      }
      roll(expression, '', secret);
    } else {
      send(text, whisperTo);
    }

    setDraft('');
  }

  return (
    <div className="flex h-full flex-col rounded-xl border border-ink-700 bg-ink-900">
      <header className="flex items-center gap-2 border-b border-ink-800 px-3 py-2">
        <span
          className={`size-2 rounded-full ${connected ? 'bg-emerald-500' : 'bg-ink-600'}`}
          title={connected ? 'Connected' : 'Disconnected'}
        />
        <h2 className="font-display text-sm text-ink-100">Table</h2>
        <span className="ml-auto text-xs text-ink-500">
          {members.filter((m) => m.online).length} of {members.length} here
        </span>
      </header>

      <ul className="flex flex-wrap gap-1.5 border-b border-ink-800 px-3 py-2">
        {members.map((member) => (
          <li
            key={member.user.id}
            className={`rounded px-1.5 py-0.5 text-xs ${
              member.online ? 'bg-ink-800 text-ink-200' : 'text-ink-600'
            }`}
            title={member.online ? 'Online' : 'Offline'}
          >
            {member.user.displayName}
            {member.role === 'dm' && <span className="ml-1 text-ember-400">DM</span>}
          </li>
        ))}
      </ul>

      <div className="flex-1 space-y-2 overflow-y-auto px-3 py-3">
        {messages.length === 0 ? (
          <p className="py-8 text-center text-sm text-ink-500">
            Nothing yet. Say something, or type <code className="text-ink-400">/1d20</code> to roll.
          </p>
        ) : (
          messages.map((message) => (
            <Message key={message.id} message={message} selfId={user?.id ?? ''} onAction={cardAction} />
          ))
        )}
        <div ref={bottom} />
      </div>

      <div className="border-t border-ink-800 px-3 py-2">
        <div className="mb-2 flex flex-wrap items-center gap-1">
          <DiceBuilder onRoll={(expression) => roll(expression, '', secret)} />
          <button
            onClick={() => setSecret(!secret)}
            title="Secret rolls are seen only by you and the DM"
            className={`ml-auto rounded border px-2 py-1 text-xs transition-colors ${
              secret
                ? 'border-arcane-400 bg-arcane-500/20 text-arcane-400'
                : 'border-ink-700 text-ink-500 hover:text-ink-300'
            }`}
          >
            {secret ? 'Secret' : 'Public'}
          </button>
        </div>

        {(inputError || error) && (
          <p className="mb-1.5 text-xs text-red-400">{inputError ?? error}</p>
        )}

        <form onSubmit={submit} className="flex gap-2">
          <select
            value={whisperTo ?? ''}
            onChange={(e) => setWhisperTo(e.target.value || null)}
            aria-label="Whisper target"
            className="max-w-28 rounded-lg border border-ink-600 bg-ink-850 px-2 text-xs text-ink-300 focus:border-arcane-400 focus:outline-none"
          >
            <option value="">Everyone</option>
            {members
              .filter((m) => m.user.id !== user?.id)
              .map((m) => (
                <option key={m.user.id} value={m.user.id}>
                  {m.user.displayName}
                </option>
              ))}
          </select>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={whisperTo ? 'Whisper…' : 'Say something, or /2d6+3'}
            aria-label="Message"
            className="min-w-0 flex-1 rounded-lg border border-ink-600 bg-ink-850 px-3 py-2 text-sm text-ink-100 placeholder:text-ink-500 focus:border-arcane-400 focus:outline-none"
          />
          <Button size="sm" type="submit" disabled={!connected}>
            Send
          </Button>
        </form>
      </div>
    </div>
  );
}

/**
 * How many of what, plus a modifier.
 *
 * Seven fixed buttons could only ever roll one die at a time, so 2d6 meant
 * typing it. The expression is still only a string the server rolls - nothing
 * here produces a number.
 */
function DiceBuilder({ onRoll }: { onRoll: (expression: string) => void }) {
  const [count, setCount] = useState(1);
  const [sides, setSides] = useState(20);
  const [modifier, setModifier] = useState(0);

  const expression =
    `${count}d${sides}` + (modifier === 0 ? '' : modifier > 0 ? `+${modifier}` : `${modifier}`);

  return (
    <div className="flex items-center gap-1">
      <input
        type="number"
        min={1}
        max={DICE_LIMITS.maxDiceCount}
        value={count}
        aria-label="How many dice"
        onChange={(e) =>
          setCount(Math.max(1, Math.min(DICE_LIMITS.maxDiceCount, Number(e.target.value) || 1)))
        }
        className="w-12 rounded border border-ink-700 bg-ink-850 px-1.5 py-1 text-center font-mono text-xs text-ink-200 focus:border-arcane-400 focus:outline-none"
      />
      <select
        value={sides}
        aria-label="Die type"
        onChange={(e) => setSides(Number(e.target.value))}
        className="rounded border border-ink-700 bg-ink-850 px-1.5 py-1 font-mono text-xs text-ink-200 focus:border-arcane-400 focus:outline-none"
      >
        {DIE_TYPES.map((die) => (
          <option key={die} value={die}>
            d{die}
          </option>
        ))}
      </select>
      <input
        type="number"
        min={-99}
        max={99}
        value={modifier}
        aria-label="Modifier"
        onChange={(e) => setModifier(Math.max(-99, Math.min(99, Number(e.target.value) || 0)))}
        className="w-12 rounded border border-ink-700 bg-ink-850 px-1.5 py-1 text-center font-mono text-xs text-ink-200 focus:border-arcane-400 focus:outline-none"
      />
      <button
        onClick={() => onRoll(expression)}
        title={`Roll ${expression}`}
        className="rounded border border-ink-700 bg-ink-850 px-2 py-1 font-mono text-xs text-ember-300 transition-colors hover:border-ember-500"
      >
        Roll {expression}
      </button>
    </div>
  );
}

function Message({
  message,
  selfId,
  onAction,
}: {
  message: WireChatMessage;
  selfId: string;
  onAction: (
    itemId: string,
    actorId: string,
    action: 'attack' | 'damage' | 'critical' | 'save' | 'versatile',
    mode?: RollMode,
  ) => void;
}) {
  const isWhisper = Boolean(message.whisperToUserId);
  const speaker = message.actorName ?? message.authorName;

  return (
    <div
      className={`rounded-lg px-2 py-1.5 text-sm ${
        isWhisper ? 'border border-arcane-500/30 bg-arcane-500/10' : ''
      }`}
    >
      <div className="flex items-baseline gap-2">
        <span className={`text-xs font-semibold ${message.userId === selfId ? 'text-ember-300' : 'text-ink-300'}`}>
          {speaker}
        </span>
        {message.actorName && (
          <span className="text-[10px] text-ink-600">{message.authorName}</span>
        )}
        {isWhisper && <span className="text-[10px] text-arcane-400">whisper</span>}
        <span className="ml-auto text-[10px] text-ink-600">
          {new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>

      {message.kind === 'roll' && message.rollData ? (
        <RollCard roll={message.rollData} />
      ) : message.kind === 'card' && message.cardData ? (
        <ItemCard card={message.cardData} onAction={onAction} />
      ) : (
        <p className="text-ink-200">{message.body}</p>
      )}
    </div>
  );
}

/**
 * What was rolled, what each die came up, then the total.
 *
 * The dice line is the point: "5" tells you nothing about whether the roll was
 * lucky, and 4 + 1 does. The library's own `output` string is kept underneath
 * because it is the only thing that explains a dropped or exploded die.
 */
function RollCard({ roll }: { roll: NonNullable<WireChatMessage['rollData']> }) {
  return (
    <div
      className={`mt-1 rounded-lg border px-3 py-2 ${
        roll.isCritical
          ? 'border-emerald-500/50 bg-emerald-500/10'
          : roll.isFumble
            ? 'border-red-500/50 bg-red-500/10'
            : 'border-ink-700 bg-ink-850'
      }`}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-mono text-xs text-ink-300">{roll.expression}</span>
        {roll.label && <span className="min-w-0 truncate text-[11px] text-ink-500">{roll.label}</span>}
      </div>

      {roll.rolls.length > 0 && (
        <div className="mt-1 font-mono text-sm text-ink-200">{roll.rolls.join(' + ')}</div>
      )}

      <div className="mt-0.5 flex items-baseline justify-between gap-3">
        <span className="font-mono text-[11px] text-ink-500">{roll.output}</span>
        <span className="font-display text-2xl font-bold text-ink-100">{roll.total}</span>
      </div>

      {roll.isCritical && (
        <div className="mt-1 text-xs font-semibold text-emerald-400">Critical hit</div>
      )}
      {roll.isFumble && <div className="mt-1 text-xs font-semibold text-red-400">Natural 1</div>}
    </div>
  );
}

const ACTION_LABELS: Record<string, string> = {
  attack: 'Attack',
  damage: 'Damage',
  critical: 'Crit',
  versatile: 'Two-handed',
  save: 'Save',
};

function ItemCard({
  card,
  onAction,
}: {
  card: WireCard;
  onAction: (
    itemId: string,
    actorId: string,
    action: 'attack' | 'damage' | 'critical' | 'save' | 'versatile',
    mode?: RollMode,
  ) => void;
}) {
  const [mode, setMode] = useState<RollMode>('normal');

  return (
    <div className="mt-1 rounded-lg border border-ink-700 bg-ink-850 px-3 py-2">
      <div className="font-display text-ink-100">{card.itemName}</div>
      <div className="text-xs text-ink-500">{card.subtitle}</div>

      {card.saveDC !== null && card.saveAbility && (
        <div className="mt-1 text-xs text-ember-300">
          DC {card.saveDC} {card.saveAbility.toUpperCase()}
        </div>
      )}

      {card.description && (
        <p className="mt-1.5 line-clamp-3 text-xs text-ink-400">{card.description}</p>
      )}

      {card.actions.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1">
          {card.actions.includes('attack') && (
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as RollMode)}
              aria-label="Roll mode"
              className="rounded border border-ink-600 bg-ink-900 px-1.5 py-1 text-[11px] text-ink-300 focus:outline-none"
            >
              <option value="normal">Normal</option>
              <option value="advantage">Advantage</option>
              <option value="disadvantage">Disadvantage</option>
            </select>
          )}
          {card.actions.map((action) => (
            <button
              key={action}
              onClick={() => onAction(card.itemId, card.actorId, action, mode)}
              className="rounded border border-ink-600 bg-ink-800 px-2 py-1 text-[11px] text-ink-200 transition-colors hover:border-ember-500 hover:text-ember-300"
            >
              {ACTION_LABELS[action] ?? action}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
