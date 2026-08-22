import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useConfirm } from './Confirm.js';
import {
  DICE_LIMITS,
  DIE_TYPES,
  describeBonus,
  formatModifier,
  tokenDistance,
  validateExpression,
  type RollMode,
} from '@dnd/shared';
import { Button } from './ui.js';
import { useTable } from '../store/table.js';
import { useAuth } from '../store/auth.js';
import type { WireAttack, WireCard, WireChatMessage } from '@dnd/shared';

export function ChatPanel({
  isDM = false,
  myActorIds = [],
}: {
  isDM?: boolean;
  /** The sheets this viewer may answer a group roll for. */
  myActorIds?: string[];
}) {
  const ask = useConfirm();
  const { messages, members, connected, send, roll, cardAction, clearChat, error } = useTable();
  const { answerGroupRoll } = useTable();
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
  const list = useRef<HTMLDivElement>(null);
  /**
   * Whether the reader is at the end of the log, and so wants to follow it.
   *
   * A ref rather than state: it is read inside an effect and never drawn, and
   * re-rendering the whole log on every scroll event is a cost for nothing.
   */
  const following = useRef(true);

  /**
   * One stored log; Battle is a filter over it, not the other half of a split.
   *
   * Chat used to *exclude* combat, which put an item card and the roll it
   * produces in different tabs: the card posts uncombatted and lands here, the
   * attack posts `combat: true` and lands in Battle. Press Attack while looking
   * at Chat and the answer arrives somewhere you are not - so the button looked
   * broken, and was reported as doing nothing, while working perfectly every
   * time.
   *
   * The rule this restores is that the result of an action appears where the
   * action was taken. Battle is still the fight on its own, for a DM who wants
   * the conversation out of the way.
   */
  const shown = tab === 'battle' ? messages.filter((message) => message.combat) : messages;

  /**
   * The log follows itself; it never moves the page.
   *
   * `scrollIntoView` was the bug: it scrolls EVERY scrollable ancestor, the
   * window included, so a message arriving anywhere dragged the whole page down
   * to the chat panel. Pressing Next turn posts a combat line, which meant the
   * board scrolled out from under the DM on every single turn - a button that
   * appeared to jump somewhere at random while doing exactly what it was asked.
   * Scrolling the list's own box cannot touch anything outside it.
   *
   * Only while the reader is already at the end, so scrolling back through a
   * fight is not yanked away by the next roll.
   */
  useEffect(() => {
    const box = list.current;
    if (!box || !following.current) return;
    box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' });
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

      <div
        ref={list}
        onScroll={(e) => {
          // Within a message's height of the end counts as following: an exact
          // comparison fails on a fractional device pixel ratio and the log
          // then stops following for no visible reason.
          const box = e.currentTarget;
          following.current = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
        }}
        className="flex-1 space-y-2 overflow-y-auto px-3 py-3"
      >
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
              myActorIds={myActorIds}
              isDM={isDM}
              onAnswer={answerGroupRoll}
              // Two calls rather than one: `halved` applies to every id in a
              // call, so the failures and the successes cannot travel together.
              onApplyDamage={(failedIds, savedIds, value, type) => {
                if (failedIds.length) applyDamage(failedIds, value, type);
                if (savedIds.length) applyDamage(savedIds, value, type, false, true);
              }}
              // The creature the blow actually landed on, and the damage type
              // it was - both of which the swing knows and a bare roll does not.
              onApplyAttack={(tokenId, amount, type) => applyDamage([tokenId], amount, type)}
            />
          ))
        )}
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
  myActorIds,
  isDM,
  onAnswer,
  onApplyDamage,
  onApplyAttack,
}: {
  message: WireChatMessage;
  selfId: string;
  myActorIds: string[];
  isDM: boolean;
  onAnswer: (messageId: string, actorId: string) => void;
  onApplyDamage: (failed: string[], saved: string[], amount: number, type: string) => void;
  onAction: (
    itemId: string,
    actorId: string,
    action: 'attack' | 'damage' | 'critical' | 'save' | 'heal',
    mode?: RollMode,
    targetTokenId?: string | null,
    versatile?: boolean,
  ) => void;
  applyTo?: string | null;
  onApply?: (amount: number) => void;
  /**
   * Damage from a swing, applied to the creature that was actually struck.
   *
   * The plain roll card applies to whatever happens to be targeted right now,
   * untyped, because a bare roll knows neither. An attack knows both, so a
   * resistance is honoured and a hit three messages ago still lands on the
   * right goblin.
   */
  onApplyAttack: (tokenId: string, amount: number, damageType: string) => void;
}) {
  const isWhisper = Boolean(message.whisperToUserId);
  const speaker = message.actorName ?? message.authorName;

  /**
   * Reaching a level is announced, not said.
   *
   * Returned before the speaker header on purpose: a banner with "Dungeon
   * Master said:" above it is a line of chat wearing a hat. The whole party
   * levels at once, so this is one announcement for the table rather than a
   * line each - the detail of what anybody gained is on their own sheet, where
   * it can be acted on.
   */
  if (message.kind === 'levelup') {
    return (
      <div className="my-3 text-center">
        <div className="text-xl font-bold tracking-wide text-amber-300 uppercase drop-shadow-[0_0_12px_rgba(252,211,77,0.35)]">
          {message.body}
        </div>
        <div className="mt-1 text-[10px] tracking-wide text-amber-200/60 uppercase">
          open your sheet to see what you gained
        </div>
      </div>
    );
  }

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

      {message.attackData ? (
        <AttackCard
          attack={message.attackData}
          // The author of the swing, or the DM. A message stored before the
          // damage moved inside the attack has no `attackData` and still draws
          // as the plain roll card underneath.
          canApply={message.userId === selfId || isDM}
          onApply={onApplyAttack}
        />
      ) : message.kind === 'roll' && message.rollData ? (
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
      ) : message.groupData ? (
        <GroupRollCard
          group={message.groupData}
          messageId={message.id}
          myActorIds={myActorIds}
          isDM={isDM}
          onAnswer={onAnswer}
          onApplyDamage={onApplyDamage}
        />
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
 * One check, several creatures, one table.
 *
 * The totals are what is being read - "did the goblins make it" is answered by
 * a column of numbers, not by eight lines of arithmetic - so they are the only
 * thing set in the display face, and the dice that produced them sit small
 * beside. This replaces a run of text where the answer to the question was the
 * least prominent thing on screen.
 *
 * Rows scroll past eight, because a fireball can catch a dozen and a card that
 * pushes the rest of the log off the screen is its own problem.
 */
function GroupRollCard({
  group,
  messageId,
  myActorIds,
  isDM,
  onAnswer,
  onApplyDamage,
}: {
  group: NonNullable<WireChatMessage['groupData']>;
  messageId: string;
  /** The sheets this viewer may roll for. */
  myActorIds: string[];
  isDM: boolean;
  onAnswer: (messageId: string, actorId: string) => void;
  onApplyDamage: (failed: string[], saved: string[], amount: number, type: string) => void;
}) {
  const rolled = group.rows.filter((row) => row.total !== null);
  const passes = rolled.filter((row) => row.passed).length;
  const waiting = group.rows.length - rolled.length;

  const [amount, setAmount] = useState('');
  const [damageType, setDamageType] = useState('fire');
  /** Half on a successful save is the common case; some effects give nothing. */
  const [halfOnSave, setHalfOnSave] = useState(true);

  const failed = group.rows.filter((row) => row.passed === false && row.tokenId);
  const saved = group.rows.filter((row) => row.passed === true && row.tokenId);
  // Named rather than silently dropped: a row with nothing on the board cannot
  // be damaged from here, and the DM needs to know which one to go and find.
  const offBoard = group.rows.filter((row) => row.total !== null && !row.tokenId);

  return (
    <div className="mt-1 rounded-lg border border-ink-700 bg-ink-850 px-3 py-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs text-ink-300">{group.label}</span>
        {group.dc !== null && (
          <span className="shrink-0 font-mono text-[11px] text-ink-500">DC {group.dc}</span>
        )}
      </div>

      <ul className="mt-1 max-h-64 space-y-0.5 overflow-y-auto">
        {group.rows.map((row, index) => {
          // Yours to press, or the DM's - they fill in for whoever is not at
          // the table, so a request cannot sit open all session.
          const canAnswer =
            row.total === null &&
            row.actorId !== null &&
            (isDM || myActorIds.includes(row.actorId));

          return (
            // Index in the key because two creatures can legitimately share a
            // name - an unnumbered pair placed by hand - and this list is never
            // reordered or filtered after it is written.
            <li key={`${row.name}-${index}`} className="flex items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate text-[11px] text-ink-300">{row.name}</span>

              {row.total === null ? (
                canAnswer ? (
                  <button
                    onClick={() => onAnswer(messageId, row.actorId!)}
                    className="shrink-0 rounded border border-ember-500/60 bg-ember-500/15 px-2 py-0.5 text-[10px] text-ember-300 transition-colors hover:bg-ember-500/25"
                  >
                    Roll {row.modifier >= 0 ? `+${row.modifier}` : row.modifier}
                  </button>
                ) : (
                  <span className="shrink-0 text-[10px] text-ink-600">waiting…</span>
                )
              ) : (
                <>
                  <span className="shrink-0 font-mono text-[10px] text-ink-600">
                    [{row.dice.join(', ')}]
                    {row.modifier >= 0 ? `+${row.modifier}` : row.modifier}
                  </span>

                  <span className="w-7 shrink-0 text-right font-display text-base font-bold text-ink-100">
                    {row.total}
                  </span>

                  {/* Kept as a fixed-width cell whether or not there is a DC, so
                      the totals stay in one column between a check and a save. */}
                  <span className="w-3 shrink-0 text-center text-xs">
                    {row.passed === null ? (
                      ''
                    ) : row.passed ? (
                      <span className="text-emerald-400">✓</span>
                    ) : (
                      <span className="text-red-400">✗</span>
                    )}
                  </span>
                </>
              )}
            </li>
          );
        })}
      </ul>

      {(group.dc !== null || waiting > 0) && (
        <div className="mt-1 border-t border-ink-800 pt-1 text-[10px] text-ink-500">
          {waiting > 0
            ? `waiting on ${waiting} of ${group.rows.length}`
            : `${passes} of ${group.rows.length} made it`}
        </div>
      )}

      {/*
        The damage a save was against, applied where the answer already is.

        A fireball otherwise means reading who failed, then finding each of them
        on the board and damaging them one at a time - and this card is already
        holding the list. Offered rather than applied automatically, for the same
        reason `RollCard` offers its button: damage gets rolled for things that
        turn out not to land.

        Only once everybody has answered, and only against a DC - a check with no
        target number has no failures to act on.
      */}
      {isDM && group.dc !== null && waiting === 0 && failed.length + saved.length > 0 && (
        <div className="mt-1.5 space-y-1.5 border-t border-ink-800 pt-1.5">
          <div className="flex gap-1">
            <input
              type="number"
              min={0}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0"
              aria-label="Damage amount"
              className="w-14 rounded border border-ink-600 bg-ink-850 px-1.5 py-1 text-center text-xs text-ink-100 focus:border-arcane-400 focus:outline-none"
            />
            <input
              value={damageType}
              onChange={(e) => setDamageType(e.target.value)}
              aria-label="Damage type"
              className="min-w-0 flex-1 rounded border border-ink-600 bg-ink-850 px-1.5 py-1 text-xs text-ink-100 focus:border-arcane-400 focus:outline-none"
            />
            <select
              value={halfOnSave ? 'half' : 'none'}
              onChange={(e) => setHalfOnSave(e.target.value === 'half')}
              aria-label="On a successful save"
              title="What a creature that made its save takes"
              className="rounded border border-ink-600 bg-ink-850 px-1 py-1 text-[10px] text-ink-300 focus:border-arcane-400 focus:outline-none"
            >
              <option value="half">half on a save</option>
              <option value="none">nothing on a save</option>
            </select>
          </div>

          <button
            disabled={!Number(amount)}
            onClick={() => {
              const value = Number(amount) || 0;
              if (!value) return;
              onApplyDamage(
                failed.map((row) => row.tokenId!),
                halfOnSave ? saved.map((row) => row.tokenId!) : [],
                value,
                damageType,
              );
              setAmount('');
            }}
            className="w-full rounded border border-red-900/60 bg-red-950/40 px-2 py-1 text-[11px] text-red-200 transition-colors hover:bg-red-900/40 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Apply to {failed.length} failed
            {halfOnSave && saved.length > 0 && `, half to ${saved.length}`}
          </button>

          {offBoard.length > 0 && (
            <p className="text-[10px] text-ink-600">
              Not on this scene, so not included: {offBoard.map((row) => row.name).join(', ')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * One swing, read top to bottom: who swung, what happened, what it cost.
 *
 * The verdict used to be a sentence glued onto the roll's label, which the card
 * then printed in a grey line at the right of the row and truncated - so the
 * answer to "did it hit" was the least legible thing on a card about hitting,
 * and the damage arrived as a separate message underneath with nothing tying
 * the two together.
 *
 * The dice for every number are shown rather than only their totals, and each
 * bonus says where it came from. `+7` is not a fact about a longsword; it is
 * Strength and proficiency, and a player who cannot see that cannot tell a
 * house rule from a bug.
 */
function AttackCard({
  attack,
  canApply,
  onApply,
}: {
  attack: WireAttack;
  /** Whether this viewer may put the damage on the creature. */
  canApply: boolean;
  onApply: (tokenId: string, amount: number, damageType: string) => void;
}) {
  const { damage } = attack;

  const tone =
    attack.outcome === 'critical'
      ? 'border-emerald-500/50 bg-emerald-500/10'
      : attack.outcome === 'miss'
        ? 'border-ink-700 bg-ink-850'
        : 'border-ember-500/40 bg-ink-850';

  const verdict =
    attack.outcome === 'critical'
      ? { label: 'Critical hit', color: 'text-emerald-400' }
      : attack.outcome === 'hit'
        ? { label: 'Hit', color: 'text-ember-300' }
        : attack.outcome === 'miss'
          ? { label: 'Miss', color: 'text-red-400' }
          : { label: 'Rolled', color: 'text-ink-400' };

  return (
    <div className={`mt-1 rounded-lg border px-3 py-2 ${tone}`}>
      <div className="font-display text-sm text-ink-100">
        {attack.attacker} attacks{attack.target ? ` ${attack.target}` : ''} with {attack.weapon}
      </div>

      {attack.mode !== 'normal' && (
        <div
          className={`mt-0.5 text-[11px] ${
            attack.mode === 'advantage' ? 'text-emerald-400' : 'text-red-400'
          }`}
        >
          at {attack.mode}
          {attack.reasons.length > 0 && ` — ${attack.reasons.join('; ')}`}
        </div>
      )}

      {/* The verdict first and in the display face, because it is the question
          being asked. A "Results" heading over it was a word explaining what a
          card about hitting things was about. */}
      <div className="mt-2 flex items-baseline gap-2">
        <span className={`font-display text-base font-bold tracking-wide uppercase ${verdict.color}`}>
          {verdict.label}
        </span>
        <span className="text-[11px] text-ink-500">{attack.reason}</span>
        <span
          className="ml-auto shrink-0 font-mono text-[11px] text-ink-500"
          title={describeBonus(attack.toHitParts) || 'no bonuses'}
        >
          {attack.roll.output}
        </span>
      </div>

      {/* What it cost, and the fact that it has already come off. The Apply
          button is gone from a landed blow: the damage exists because the dice
          beat an armour class, so pressing it again only risked applying twice. */}
      {damage && (
        <div className="mt-1.5 flex items-baseline gap-2 rounded border border-ink-700 bg-ink-900 px-2 py-1.5">
          <span className="font-display text-xl font-bold text-ember-300">
            {damage.roll.total}
          </span>
          <span className="text-[11px] text-ink-400">
            {damage.type || 'damage'}
            {damage.critical && <span className="ml-1.5 text-emerald-400">dice doubled</span>}
            {damage.twoHanded && <span className="ml-1.5 text-ink-500">two-handed</span>}
          </span>
          <span
            className="ml-auto shrink-0 font-mono text-[10px] text-ink-600"
            title={describeBonus(damage.parts) || 'no bonuses'}
          >
            {damage.roll.output}
          </span>
        </div>
      )}

      {damage && attack.target && (
        damage.applied ? (
          <div className="mt-1 text-[11px] text-ink-500">
            Taken off {attack.target}.
          </div>
        ) : (
          canApply &&
          damage.tokenId && (
            <button
              onClick={() => onApply(damage.tokenId!, damage.roll.total, damage.type)}
              className="mt-1.5 w-full rounded border border-ember-500/50 px-2 py-1 text-[11px] text-ember-300 transition-colors hover:bg-ember-500/15"
            >
              Apply {damage.roll.total} to {attack.target}
            </button>
          )
        )
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
    action: 'attack' | 'damage' | 'critical' | 'save' | 'heal',
    mode?: RollMode,
    targetTokenId?: string | null,
    versatile?: boolean,
  ) => void;
}) {
  // The player's own call, and nothing else. Both circumstantial sources -
  // the target's conditions and the distance - are recomputed by the server when
  // the button is pressed, so a card posted three rounds ago cannot carry a
  // range penalty that no longer applies.
  const [mode, setMode] = useState<RollMode>('normal');

  /**
   * Which grip, for a versatile weapon.
   *
   * A choice rather than the second button it used to be. `Two-handed` sat
   * beside `Attack` and rolled damage with no attack roll in front of it, so a
   * card advertising `1d8 Slashing` answered with `1d10+4` and there was no way
   * to find out why except by asking. Here the dice change on the card as the
   * grip changes, before anything is rolled.
   */
  const [twoHanded, setTwoHanded] = useState(false);
  const numbers = card.numbers;
  const versatile = numbers?.versatileDice ?? '';
  const dice = twoHanded && versatile ? versatile : (numbers?.damageDice ?? '');

  return (
    <div className="mt-1 rounded-lg border border-ink-700 bg-ink-850 px-3 py-2">
      <div className="font-display text-ink-100">{card.itemName}</div>
      <div className="text-xs text-ink-500">{card.subtitle}</div>

      {/*
        What the buttons will roll, before anybody presses one.

        Every number here is derived from the sheet, and derived numbers are
        exactly the ones a player cannot check: the card said `1d8 Slashing`
        and the log said `1d10+4`, with the grip and the Strength modifier
        both invisible. Each part carries where it came from.
      */}
      {numbers && (numbers.toHit !== null || dice || numbers.healingDice) && (
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[11px]">
          {numbers.toHit !== null && (
            <span className="text-ember-300" title={describeBonus(numbers.toHitParts) || 'no bonuses'}>
              {formatModifier(numbers.toHit)} to hit
              {numbers.toHitParts.length > 0 && (
                <span className="ml-1 text-ink-600">({describeBonus(numbers.toHitParts)})</span>
              )}
            </span>
          )}
          {dice && (
            <span className="text-ink-300" title={describeBonus(numbers.damageParts) || 'no bonuses'}>
              {dice}
              {numbers.damageBonus !== 0 && formatModifier(numbers.damageBonus)}{' '}
              <span className="text-ink-500">{numbers.damageType} damage</span>
              {numbers.damageParts.length > 0 && (
                <span className="ml-1 text-ink-600">({describeBonus(numbers.damageParts)})</span>
              )}
            </span>
          )}
          {numbers.healingDice && (
            <span className="text-emerald-400">{numbers.healingDice} healing</span>
          )}
        </div>
      )}

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
          {card.actions.includes('attack') && versatile && (
            <select
              value={twoHanded ? 'two' : 'one'}
              onChange={(e) => setTwoHanded(e.target.value === 'two')}
              aria-label="Grip"
              className="rounded border border-ink-600 bg-ink-900 px-1.5 py-1 text-[11px] text-ink-300 focus:outline-none"
            >
              <option value="one">One-handed ({numbers?.damageDice})</option>
              <option value="two">Two-handed ({versatile})</option>
            </select>
          )}
          {card.actions.map((action) => (
            <button
              key={action}
              onClick={() =>
                onAction(card.itemId, card.actorId, action, mode, card.targetTokenId, twoHanded)
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
