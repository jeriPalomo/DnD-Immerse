import { useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { OWNERSHIP, abilityModifier, formatModifier, templateForSpell } from '@dnd/shared';
import type { WireToken } from '@dnd/shared';
import { Alert, Badge, Card, Spinner } from '../components/ui.js';
import { ChatPanel } from '../components/ChatPanel.js';
import { BattleMap } from '../components/board/BattleMap.js';
import { InitiativeTracker } from '../components/board/InitiativeTracker.js';
import { SceneManager } from '../components/board/SceneManager.js';
import { ReachPanel } from '../components/board/ReachPanel.js';
import { TargetPanel } from '../components/board/TargetPanel.js';
import { TokenHUD } from '../components/board/TokenHUD.js';
import { api } from '../lib/api.js';
import { useTable } from '../store/table.js';
import { useAuth } from '../store/auth.js';
import { ErrorBoundary } from '../components/ErrorBoundary.js';
import { MySheetDrawer } from '../components/board/MySheetDrawer.js';
import { ShortcutHelp } from '../components/board/ShortcutHelp.js';
import { HandoutReveal } from '../components/board/HandoutReveal.js';
import { Toast } from '../components/board/Toast.js';
import { SidebarTabs } from '../components/board/SidebarTabs.js';
import { RunPanel } from '../components/board/RunPanel.js';
import { JournalPanel } from '../components/board/JournalPanel.js';
import { TurnBar, TURN_BAR_HEIGHT_REM } from '../components/board/TurnBar.js';
import { useHotkeys } from '../lib/useHotkeys.js';
import type { Actor, Item } from '../store/sheet.js';

type PartyMember = Partial<Actor> & { id: string; name: string; access: number };

/** The live table: battle map, party, chat and dice. */
export default function CampaignTable() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const table = useTable();

  const [campaign, setCampaign] = useState<{ name: string; role: string } | null>(null);
  const [party, setParty] = useState<PartyMember[]>([]);
  const [myActor, setMyActor] = useState<Actor | null>(null);
  const [myItems, setMyItems] = useState<Item[]>([]);
  /** The DM's acting creature: the sheet behind the token they have selected. */
  const [dmActor, setDmActor] = useState<Actor | null>(null);
  const [dmItems, setDmItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [showSheet, setShowSheet] = useState(false);
  const [focusBoard, setFocusBoard] = useState(false);

  useEffect(() => {
    if (!id) return;
    table.connect(id);
    return () => table.disconnect();
    // Reconnect only when the campaign changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    if (!id) return;
    void (async () => {
      try {
        const [campaignRes, partyRes] = await Promise.all([
          api.get<{ campaign: { name: string; role: string } }>(`/api/campaigns/${id}`),
          api.get<{ actors: PartyMember[] }>(`/api/campaigns/${id}/actors`),
        ]);
        setCampaign(campaignRes.campaign);
        setParty(partyRes.actors);

        // Your own character, not merely an actor you own. A DM owns every NPC
        // they create, and this list is ordered by name - so without the type
        // check the DM "played as" whichever NPC sorted first, which decided
        // the attacks they were offered, the token range was measured from,
        // and the name on their chat messages.
        const mine = partyRes.actors.find(
          (a) => a.ownerUserId === user?.id && a.type === 'character',
        );
        if (mine) {
          useTable.getState().setActiveActor(mine.id);
          const sheet = await api.get<{ actor: Actor; items: Item[] }>(`/api/actors/${mine.id}`);
          setMyActor(sheet.actor);
          setMyItems(sheet.items);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not load the table');
      } finally {
        setLoading(false);
      }
    })();
  }, [id, user?.id]);

  /**
   * Shortcuts are bound before any early return, or React sees a different
   * number of hooks between the loading and loaded renders.
   *
   * Handlers read the store when the key is pressed rather than closing over
   * values from render, which also means they can never act on a stale
   * selection.
   */
  /** Moves the selected token a square, snapped and persisted in one step. */
  function nudge(event: KeyboardEvent, dx: number, dy: number) {
    event.preventDefault();
    const state = useTable.getState();
    const token = state.tokens.find((t) => t.id === state.selectedTokenId);
    if (!token || token.locked) return;
    if (campaign?.role !== 'dm' && token.ownerUserId !== user?.id) return;

    state.commitToken(token.id, token.x + dx, token.y + dy);
  }

  useHotkeys({
    Escape: () => {
      setShowHelp((open) => {
        if (open) return false;
        useTable.getState().target(null);
        useTable.getState().select(null);
        return false;
      });
    },
    Delete: () => {
      const { selectedTokenId, deleteToken } = useTable.getState();
      if (selectedTokenId && campaign?.role === 'dm') deleteToken(selectedTokenId);
    },
    ArrowLeft: (e) => nudge(e, -1, 0),
    ArrowRight: (e) => nudge(e, 1, 0),
    ArrowUp: (e) => nudge(e, 0, -1),
    ArrowDown: (e) => nudge(e, 0, 1),
    Enter: (e) => {
      e.preventDefault();
      document.querySelector<HTMLInputElement>('input[aria-label="Message"]')?.focus();
    },
    t: () => {
      const { selectedTokenId, target } = useTable.getState();
      if (selectedTokenId) target(selectedTokenId);
    },
    // Enemy threat ranges, on and off. `r` rather than anything more obvious
    // because Ctrl+R has to keep reloading the page.
    r: () => useTable.getState().toggleThreat(),
    ' ': (e) => {
      // Space would otherwise scroll the page behind the board.
      e.preventDefault();
      const state = useTable.getState();
      if (campaign?.role === 'dm' && state.encounter) state.nextTurn();
    },
    '?': () => setShowHelp(true),
    // Your own sheet, without leaving the board. Nothing to open if you have
    // no character here - the DM runs NPCs from their own panels.
    c: () => setShowSheet((open) => !open),
    '\\': () => setFocusBoard((on) => !on),
    // Explicitly requested, so Ctrl+F and Ctrl+R still reach the browser.
    'ctrl+z': (e) => {
      e.preventDefault();
      useTable.getState().undo();
    },
  });

  /**
   * Follow the DM's selection with the sheet behind it, so the target panel
   * offers that creature's own attacks. Players never take this path: their
   * character is fixed for the session and fetched once above.
   *
   * Above the early returns, with the store read directly rather than through
   * the values derived below them: this component returns early while loading,
   * and a hook after that point is React error #310 - more hooks on the second
   * render than the first.
   */
  const selectedActorId =
    campaign?.role === 'dm'
      ? (table.tokens.find((t) => t.id === table.selectedTokenId)?.actorId ?? null)
      : null;

  useEffect(() => {
    if (!selectedActorId) {
      setDmActor(null);
      setDmItems([]);
      return;
    }

    let cancelled = false;
    void api
      .get<{ actor: Actor; items: Item[] }>(`/api/actors/${selectedActorId}`)
      .then((sheet) => {
        if (cancelled) return;
        setDmActor(sheet.actor);
        setDmItems(sheet.items);
      })
      .catch(() => {
        // An unlinked token with no sheet behind it is ordinary, not an error.
        if (!cancelled) {
          setDmActor(null);
          setDmItems([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedActorId]);

  if (loading) return <Spinner />;
  if (error) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10">
        <Alert>{error}</Alert>
      </div>
    );
  }

  const isDM = campaign?.role === 'dm';
  const { scene, tokens, selectedTokenId, targetTokenId, activeActorId } = table;

  const selected = tokens.find((t) => t.id === selectedTokenId) ?? null;
  const targeted = tokens.find((t) => t.id === targetTokenId) ?? null;
  // Your own token on the board, used as the origin for range checks.
  const myToken = tokens.find((t) => t.actorId && t.actorId === activeActorId) ?? null;

  const canEditSelected = Boolean(selected && (isDM || selected.ownerUserId === user?.id));

  /**
   * Who is acting.
   *
   * A player always acts as their own character. A DM acts as whatever they
   * have selected, which is the only answer that can be right: they run every
   * monster on the board, so "the DM's creature" is a question about the
   * current click, not about ownership.
   */
  /**
   * The sheets this person may roll for when the DM asks the party.
   *
   * From the roster rather than from their tokens, because a character with
   * nothing on the board is still theirs to roll - and a player with two
   * characters is asked for both.
   */
  const myActorIds = party
    .filter((member) => member.ownerUserId === user?.id && member.type === 'character')
    .map((member) => member.id);

  const actingActor = isDM ? dmActor : myActor;
  const actingItems = isDM ? dmItems : myItems;
  const actingActorId = isDM ? (dmActor?.id ?? null) : activeActorId;
  /** The origin for range checks: the creature actually swinging. */
  const actingToken = isDM ? selected : (myToken ?? selected);

  /**
   * Use an item on a creature.
   *
   * Shared by the target panel and the reach list rather than written twice:
   * two copies of "post the card, then drop the spell's own template" is two
   * places for a Fireball to stop drawing its circle.
   */
  function useItemOn(item: Item, victim: WireToken) {
    if (!actingActorId) return;

    // The card remembers who it was aimed at, so a spell save is rolled by the
    // target rather than by the caster. Range is not carried: the server
    // measures it when the button is pressed.
    table.postCard(item.id, actingActorId, victim.id);
    table.target(victim.id);

    // An area spell also drops its own outline on the target, built from the
    // spell's own area so Fireball is a 20 ft circle without anyone
    // configuring one.
    const built = templateForSpell(
      item.system.areaOfEffect as { shape?: string; size?: number; width?: number | null } | null,
      { x: victim.x + victim.w / 2, y: victim.y + victim.h / 2 },
      actingToken
        ? (Math.atan2(victim.y - actingToken.y, victim.x - actingToken.x) * 180) / Math.PI
        : 0,
    );
    if (built) {
      table.placeTemplate({
        shape: built.shape,
        x: built.x,
        y: built.y,
        direction: built.direction,
        distance: built.distance,
        width: built.width,
      });
    }
  }

  /**
   * The board's height budget. 8rem is the header; the turn bar takes its own
   * space above the grid while a fight is running, and without subtracting it a
   * tall map runs past the bottom of the window - the same class of bug as the
   * 5:1 map that once covered the sidebar.
   */
  const boardOffsetRem = 8 + (table.encounter?.isActive ? TURN_BAR_HEIGHT_REM + 0.75 : 0);


  return (
    <div className="mx-auto max-w-[110rem] px-4 py-4">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <Link to={`/campaigns/${id}`} className="text-sm text-ink-400 hover:text-ink-200">
          &larr; {campaign?.name}
        </Link>
        {isDM && <Badge tone="dm">DM</Badge>}
        {scene && <span className="text-xs text-ink-500">{scene.name}</span>}

        {/* The shortcut panel was reachable only by pressing "?", which nobody
            discovers. Same handler, given something to click. */}
        {myActor && (
          <button
            onClick={() => setShowSheet(true)}
            title={`Your sheet: ${myActor.name} (C)`}
            className="ml-auto rounded border border-ink-700 px-2 py-0.5 text-xs text-ink-400 transition-colors hover:border-ink-500 hover:text-ink-100"
          >
            My sheet
          </button>
        )}

        <button
          onClick={() => setShowHelp(true)}
          title="Keyboard shortcuts (?)"
          aria-label="Keyboard shortcuts"
          className="size-6 shrink-0 rounded-full border border-ink-700 text-xs text-ink-500 transition-colors hover:border-ink-500 hover:text-ink-200"
        >
          ?
        </button>
      </div>

      <TurnBar isDM={isDM} />

      <div
        className={
          focusBoard
            ? 'grid gap-3'
            : 'grid gap-3 xl:grid-cols-[minmax(0,1fr)_320px_360px]'
        }
      >
        {/*
          The board takes the map's aspect ratio, so a long thin bridge gets a
          long thin box instead of 350px of black above and below it. CSS does
          the clamping: max-height keeps a tall map inside the window, and
          min-height stops an extreme ratio collapsing into a sliver - at which
          point the existing fitToMap centring takes over, as it does today.
        */}
        <div
          // w-full + max-w-full are load-bearing: with an aspect ratio and a
          // min-height, CSS satisfies the height first and then demands the
          // width the ratio implies - which for a 5:1 map overflowed the
          // column and covered the sidebar and chat entirely.
          className="min-h-64 w-full max-w-full overflow-hidden"
          style={
            scene?.mapWidth && scene.mapHeight
              ? {
                  aspectRatio: `${scene.mapWidth} / ${scene.mapHeight}`,
                  maxHeight: `calc(100vh - ${boardOffsetRem}rem)`,
                }
              : { height: `calc(100vh - ${boardOffsetRem}rem)`, minHeight: '420px' }
          }
        >
          <ErrorBoundary label="The battle map">
            <BattleMap
              isDM={Boolean(isDM)}
              focused={focusBoard}
              onToggleFocus={() => setFocusBoard((on) => !on)}
            />
          </ErrorBoundary>
        </div>

        {/*
          Contextual column. Transient panels sit above the tabs: a token HUD you
          have to hunt for after clicking a token is worse than one that is
          simply always in the same place.

          `min-h-0` is load-bearing next to the fixed height. Without it a flex
          child will not shrink below its content, so a selected token plus six
          characters in the party pushed the bottom of this column off the
          screen - with no overflow rule anywhere to scroll it back.
        */}
        <div
          className={`flex min-h-0 flex-col gap-3 xl:h-[calc(100vh-8rem)] ${
            focusBoard ? 'hidden' : ''
          }`}
        >
          {/*
            The transient panels, capped together. A spell list on the target
            panel is arbitrarily long, and left uncapped it squeezes the tab
            stack underneath to nothing - so they share a slice and scroll
            within it.

            A third rather than a half, measured rather than guessed: at 45% the
            token HUD took 370px of an 822px column, the party another 278, and
            the tab stack was left with 150 - which is a Combat panel you cannot
            work in. The tabs are the working surface and get the largest share.
          */}
          <div className="max-h-[34%] shrink-0 space-y-3 overflow-y-auto">
          {/* What the move made possible, before anything is targeted. */}
          {scene && (
            <ReachPanel
              self={actingToken}
              actor={actingActor}
              items={actingItems}
              tokens={tokens}
              scene={scene}
              onUse={useItemOn}
            />
          )}

          {targeted && scene && (
            <TargetPanel
              self={actingToken}
              target={targeted}
              scene={scene}
              actor={actingActor}
              items={actingItems}
              onUse={(item) => useItemOn(item, targeted)}
              onClear={() => table.target(null)}
            />
          )}

          {selected && (
            <TokenHUD
              token={selected}
              campaignId={id ?? ''}
              isDM={Boolean(isDM)}
              canEdit={canEditSelected}
              onUpdate={(fields) => table.updateToken(selected.id, fields)}
              onDelete={() => table.deleteToken(selected.id)}
            />
          )}
          </div>

          {/*
            Split by WHEN a tool is used, not by what it is.

            Everything under Combat is touched with four people watching: whose
            turn it is, what just took damage, dropping a goblin in. Everything
            under Map is done alone between sessions: building it, calibrating
            its grid, drawing walls. Placing a creature used to sit two clicks
            inside the prep panel, so a mid-fight addition meant leaving the
            initiative order and finding your way back.

            The journal is neither. It was a collapsed section at the bottom of
            the combat panel, which is both the wrong place to keep notes and the
            wrong place to look for them.

            A player gets Combat and Journal; there are no map tools to give
            them, and one tab is not worth a switch, so the fight sits bare.
          */}
          {isDM && id ? (
            <SidebarTabs
              tabs={[
                {
                  id: 'run',
                  label: 'Combat',
                  node: <RunPanel campaignId={id} isDM myActorIds={myActorIds} />,
                },
                { id: 'prep', label: 'Map', node: <SceneManager campaignId={id} /> },
                { id: 'journal', label: 'Journal', node: <JournalPanel campaignId={id} isDM /> },
              ]}
            />
          ) : id ? (
            <SidebarTabs
              tabs={[
                {
                  id: 'run',
                  label: 'Combat',
                  node: <RunPanel campaignId={id} isDM={false} myActorIds={myActorIds} />,
                },
                {
                  id: 'journal',
                  label: 'Journal',
                  node: <JournalPanel campaignId={id} isDM={false} />,
                },
              ]}
            />
          ) : (
            <InitiativeTracker isDM={false} />
          )}

          {/* Pinned below the tabs: the party is for glancing at, not working
              in - so it is capped rather than allowed to grow. Six characters
              used to take the whole column and push its own tail off the
              bottom of the window. */}
          <Card className="shrink-0 p-3">
            <h2 className="mb-2 font-display text-sm text-ink-100">Party</h2>
            {party.length === 0 ? (
              <p className="text-xs text-ink-500">No characters assigned yet.</p>
            ) : (
              <ul className="max-h-40 space-y-1.5 overflow-y-auto">
                {party.map((member) => (
                  <PartyRow key={member.id} member={member} isSelf={member.ownerUserId === user?.id} />
                ))}
              </ul>
            )}
          </Card>
        </div>

        {/* Chat */}
        <div className={`h-[calc(100vh-8rem)] min-h-[420px] ${focusBoard ? 'hidden' : ''}`}>
          <ErrorBoundary label="Chat">
            <ChatPanel isDM={Boolean(isDM)} myActorIds={myActorIds} />
          </ErrorBoundary>
        </div>
      </div>

      {showHelp && <ShortcutHelp onClose={() => setShowHelp(false)} />}
      {showSheet && myActor && (
        <MySheetDrawer actor={myActor} items={myItems} onClose={() => setShowSheet(false)} />
      )}

      <Toast />

      <HandoutReveal />
    </div>
  );
}

function PartyRow({ member, isSelf }: { member: PartyMember; isSelf: boolean }) {
  const location = useLocation();
  const detailed = (member.access ?? 0) >= OWNERSHIP.observer;
  const hpPercent =
    detailed && member.hpMax ? Math.max(0, Math.min(100, ((member.hpCurrent ?? 0) / member.hpMax) * 100)) : 0;

  return (
    <li className={`rounded-lg border p-2 ${isSelf ? 'border-ember-500/40 bg-ember-500/5' : 'border-ink-800'}`}>
      <div className="flex items-center gap-2">
        <div className="size-7 shrink-0 overflow-hidden rounded bg-ink-800">
          {member.portraitUrl ? (
            <img src={member.portraitUrl} alt="" className="size-full object-cover" />
          ) : (
            <div className="flex size-full items-center justify-center text-[10px] text-ink-500">
              {member.name.slice(0, 1)}
            </div>
          )}
        </div>
        <Link
          to={`/characters/${member.id}`}
          state={{ path: location.pathname, label: 'Back to the table' }}
          className="min-w-0 flex-1 truncate text-xs text-ink-100 hover:text-ember-300"
        >
          {member.name}
        </Link>
        {detailed && member.dex !== undefined && (
          // Labelled, because the bare number reads as "this character's
          // number". It is the Dexterity modifier, which is what 5e initiative
          // adds to the d20 - the same thing `initiativeExpression` rolls.
          <span
            title="Initiative modifier — a d20 plus this"
            className="text-[10px] text-ink-600"
          >
            {formatModifier(abilityModifier(member.dex))}
          </span>
        )}
      </div>
      {detailed ? (
        <div className="mt-1.5">
          <div className="flex justify-between text-[10px] text-ink-500">
            <span>
              {member.hpCurrent}/{member.hpMax}
            </span>
            <span>AC {member.armorClass}</span>
          </div>
          <div className="mt-0.5 h-1 overflow-hidden rounded-full bg-ink-950">
            <div
              className={`h-full ${hpPercent <= 50 ? 'bg-ember-500' : 'bg-emerald-600'}`}
              style={{ width: `${hpPercent}%` }}
            />
          </div>
        </div>
      ) : (
        <p className="mt-1 text-[10px] text-ink-600">Sheet not shared</p>
      )}
    </li>
  );
}
