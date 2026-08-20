import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useConfirm } from './Confirm.js';
import {
  DICE_LIMITS,
  DIE_TYPES,
  tokenDistance,
  validateExpression,
  type RollMode,
} from '@dnd/shared';
import { Button } from './ui.js';
import { useTable } from '../store/table.js';
import { useAuth } from '../store/auth.js';
import type { WireCard, WireChatMessage } from '@dnd/shared';

export function ChatPanel({ isDM = false }: { isDM?: boolean }) {
  const ask = useConfirm();
  const { messages, members, connected, send, roll, cardAction, clearChat, error } = useTable();
  const { tokens, targetTokenId, applyDamage } = useTable();
  const { user } = useAuth();

  /**
   * Whether this player is close enough to whisper that one.
   *
   * The DM is always reachable, and the DM can whisper anyone. Otherwise the two
   * tokens have to be adjacent, measured the same way the server measures it -
   * this only greys the option out, the rule is enforced there.
   *
   * It reads the tokens THIS client was sent, which are already filtered by what
   * the player can see. So a party member somewhere out of sight reads as out of
   * range and greys, which is the safe direction to be wrong in: the client is
   * never more permissive than the server.
   */
  function whisperReach(memberId: string, memberIsDM: boolean): boolean {
    if (isDM || memberIsDM) return true;

    const mine = tokens.filter((t) => t.ownerUserId === user?.id && t.layer !== 'gm');
    const theirs = tokens.filter((t) => t.ownerUserId === memberId && t.layer !== 'gm');
    return mine.some((a) => theirs.some((b) => tokenDistance(a, b) <= 1));
  }

  // A damage roll can be applied to whatever is targeted, so long as it is not
  // somebody's character - the server enforces that; this only offers it.
  const target = tokens.find((t) => t.id === targetTokenId) ?? null;
  const applyTo = target && !target.ownerUserId ? target.name : null;

  const [draft, setDraft] = useState('');
  const [whisperTo, setWhisperTo] = useState<string | null>(null);
  const [secret, setSecret] = useState(false);
  const [inputError, setInputError] = useState<string | null>(null);
  const [tab, setTab] = useState<'chat' | 'battle'>('chat');
  const bottom = useRef<HTMLDivElement>(null);

  // One stored log, two views over it: a fight used to bury the conversation
  // and the conversation used to bury the fight.
  const shown = messages.filter((message) => (tab === 'battle' ? message.combat : !message.combat));

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth' });
  }, [shown.length]);

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
      // Checked before sending, so a whisper to someone who has walked off does
      // not cost the player the sentence they just typed. The server refuses it
      // either way; this only saves a round trip and the draft.
      if (whisperTo) {
        const to = members.find((m) => m.user.id === whisperTo);
        if (to && !whisperReach(to.user.id, to.role === 'dm')) {
          setInputError(`${to.user.displayName} is too far away to whisper.`);
          return;
        }
      }
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
        <div role="tablist" aria-label="Log" className="flex gap-1">
          {(['chat', 'battle'] as const).map((key) => (
            <button
              key={key}
              role="tab"
              aria-selected={tab === key}
              onClick={() => setTab(key)}
              className={`rounded px-2 py-0.5 text-xs capitalize transition-colors ${
                tab === key ? 'bg-ink-800 text-ink-100' : 'text-ink-500 hover:text-ink-300'
              }`}
            >
              {key === 'battle' ? 'Battle' : 'Chat'}
            </button>
          ))}
        </div>
        {isDM && (
          <button
            onClick={() => {
              // One table holds both tabs, so say so - "clear chat" would read
              // as leaving the battle log alone.
              void ask({
                title: 'Delete the whole log?',
                body: 'Chat and battle both, for everyone at the table. This cannot be undone.',
                confirmLabel: 'Delete log',
                danger: true,
              }).then((ok) => ok && clearChat());
            }}
            className="text-xs text-ink-600 hover:text-red-400"
          >
            Clear
          </button>
        )}
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
        {shown.length === 0 ? (
          <p className="py-8 text-center text-sm text-ink-500">
            {tab === 'battle' ? (
              'No blows landed yet.'
            ) : (
              <>
                Nothing yet. Say something, or type <code className="text-ink-400">/1d20</code> to roll.
              </>
            )}
          </p>
        ) : (
          shown.map((message) => (
            <Message
              key={message.id}
              message={message}
              selfId={user?.id ?? ''}
              onAction={cardAction}
              applyTo={applyTo}
              // Untyped: the roll card does not know which of a weapon's damage
              // types this was, and the server treats '' as no resistance match.
              onApply={(amount) => target && applyDamage([target.id], amount, '')}
            />
          ))
        )}
        <div ref={bottom} />
      </div>

      <div className="border-t border-ink-800 px-3 py-2">
        <div className="mb-2">
          <DiceBuilder
            onRoll={(expression) => roll(expression, '', secret)}
            trailing={
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
            }
          />
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
              .map((m) => {
                // Listed and disabled rather than dropped: a name that silently
                // vanishes mid-session reads as a bug, where "too far" teaches
                // the rule.
                const reachable = whisperReach(m.user.id, m.role === 'dm');
                return (
                  <option key={m.user.id} value={m.user.id} disabled={!reachable}>
                    {m.user.displayName}
                    {reachable ? '' : ' — too far'}
                  </option>
                );
              })}
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
function DiceBuilder({
  onRoll,
  trailing,
}: {
  onRoll: (expression: string) => void;
  /** Sits at the end of the field row, so the roll button gets its own line. */
  trailing?: React.ReactNode;
}) {
  const [count, setCount] = useState(1);
  const [sides, setSides] = useState(20);
  const [modifier, setModifier] = useState(0);

  const expression =
    `${count}d${sides}` + (modifier === 0 ? '' : modifier > 0 ? `+${modifier}` : `${modifier}`);

  const field =
    'rounded border border-ink-700 bg-ink-850 px-1.5 py-1 font-mono text-xs text-ink-200 focus:border-arcane-400 focus:outline-none';

  return (
    <div className="w-full space-y-1.5">
      <div className="flex flex-wrap items-center gap-1">
        <input
          type="number"
          min={1}
          max={DICE_LIMITS.maxDiceCount}
          value={count}
          aria-label="How many dice"
          onChange={(e) =>
            setCount(Math.max(1, Math.min(DICE_LIMITS.maxDiceCount, Number(e.target.value) || 1)))
          }
          className={`w-12 text-center ${field}`}
        />
        <select
          value={sides}
          aria-label="Die type"
          onChange={(e) => setSides(Number(e.target.value))}
          className={field}
        >
          {DIE_TYPES.map((die) => (
            <option key={die} value={die}>
              d{die}
            </option>
          ))}
        </select>

        {/* Says what the last box is for. Without it the bare number reads as
            another die count, and nobody found the bonus. */}
        <span aria-hidden className="px-0.5 font-mono text-xs text-ink-500">
          +
        </span>
        <input
          type="number"
          min={-99}
          max={99}
          value={modifier}
          aria-label="Modifier to add to the roll"
          onChange={(e) => setModifier(Math.max(-99, Math.min(99, Number(e.target.value) || 0)))}
          className={`w-12 text-center ${field}`}
        />

        {trailing}
      </div>

      <button
        onClick={() => onRoll(expression)}
        title={`Roll ${expression}`}
        className="mx-auto block rounded border border-ink-700 bg-ink-850 px-5 py-1.5 font-mono text-sm text-ember-300 transition-colors hover:border-ember-500 hover:bg-ember-500/10"
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
  applyTo,
  onApply,
}: {
  message: WireChatMessage;
  selfId: string;
  onAction: (
    itemId: string,
    actorId: string,
    action: 'attack' | 'damage' | 'critical' | 'save' | 'versatile' | 'heal',
    mode?: RollMode,
    targetTokenId?: string | null,
  ) => void;
  applyTo?: string | null;
  onApply?: (amount: number) => void;
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
        <RollCard
          roll={message.rollData}
          // Only your own damage rolls, and only while something is targeted.
          applyTo={
            message.userId === selfId && /damage/i.test(message.rollData.label) ? applyTo : null
          }
          onApply={() => onApply?.(message.rollData!.total)}
        />
      ) : message.kind === 'card' && message.cardData ? (
        <ItemCard card={message.cardData} onAction={onAction} />
      ) : (
        // `whitespace-pre-line`, because some bodies are several lines and were
        // arriving as one run-on sentence. A group roll is written as a line per
        // character, and every one of those newlines was being collapsed:
        // "Group WIS saving throw Thorin: 1d20+2: [7]+2 = 9 Elaria: ...".
        <p className="whitespace-pre-line text-ink-200">{message.body}</p>
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
function RollCard({
  roll,
  applyTo,
  onApply,
}: {
  roll: NonNullable<WireChatMessage['rollData']>;
  /** Name of the targeted token, when this roll can be applied to it. */
  applyTo?: string | null;
  onApply?: () => void;
}) {
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

      {/* Offered rather than applied: damage gets rolled for all sorts of
          reasons, including attacks that turned out to miss. */}
      {applyTo && (
        <button
          onClick={onApply}
          className="mt-2 w-full rounded border border-ember-500/50 px-2 py-1 text-[11px] text-ember-300 transition-colors hover:bg-ember-500/15"
        >
          Apply {roll.total} to {applyTo}
        </button>
      )}
    </div>
  );
}

const ACTION_LABELS: Record<string, string> = {
  attack: 'Attack',
  damage: 'Damage',
  critical: 'Crit',
  versatile: 'Two-handed',
  save: 'Save',
  heal: 'Heal',
};

function ItemCard({
  card,
  onAction,
}: {
  card: WireCard;
  onAction: (
    itemId: string,
    actorId: string,
    action: 'attack' | 'damage' | 'critical' | 'save' | 'versatile' | 'heal',
    mode?: RollMode,
    targetTokenId?: string | null,
  ) => void;
}) {
  // The player's own call, and nothing else. Both circumstantial sources -
  // the target's conditions and the distance - are recomputed by the server when
  // the button is pressed, so a card posted three rounds ago cannot carry a
  // range penalty that no longer applies.
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
              onClick={() =>
                onAction(card.itemId, card.actorId, action, mode, card.targetTokenId)
              }
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
