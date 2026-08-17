import { useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { OWNERSHIP, abilityModifier, formatModifier, templateForSpell } from '@dnd/shared';
import { Alert, Badge, Card, Spinner } from '../components/ui.js';
import { ChatPanel } from '../components/ChatPanel.js';
import { BattleMap } from '../components/board/BattleMap.js';
import { InitiativeTracker } from '../components/board/InitiativeTracker.js';
import { JournalPanel } from '../components/board/JournalPanel.js';
import { SceneManager } from '../components/board/SceneManager.js';
import { TargetPanel } from '../components/board/TargetPanel.js';
import { TokenHUD } from '../components/board/TokenHUD.js';
import { api } from '../lib/api.js';
import { useTable } from '../store/table.js';
import { useAuth } from '../store/auth.js';
import { ErrorBoundary } from '../components/ErrorBoundary.js';
import { ShortcutHelp } from '../components/board/ShortcutHelp.js';
import { HandoutReveal } from '../components/board/HandoutReveal.js';
import { Toast } from '../components/board/Toast.js';
import { SidebarTabs } from '../components/board/SidebarTabs.js';
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
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

        const mine = partyRes.actors.find((a) => a.ownerUserId === user?.id);
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
    '\\': () => setFocusBoard((on) => !on),
    // Explicitly requested, so Ctrl+F and Ctrl+R still reach the browser.
    'ctrl+z': (e) => {
      e.preventDefault();
      useTable.getState().undo();
    },
  });

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


  return (
    <div className="mx-auto max-w-[110rem] px-4 py-4">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <Link to={`/campaigns/${id}`} className="text-sm text-ink-400 hover:text-ink-200">
          &larr; {campaign?.name}
        </Link>
        {isDM && <Badge tone="dm">DM</Badge>}
        {scene && <span className="text-xs text-ink-500">{scene.name}</span>}
      </div>

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
                  maxHeight: 'calc(100vh - 8rem)',
                }
              : { height: 'calc(100vh - 8rem)', minHeight: '420px' }
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

        {/* Contextual column. Transient panels sit above the tabs: a token
            HUD you have to hunt for after clicking a token is worse than one
            that is simply always in the same place. */}
        <div className={`flex flex-col gap-3 xl:h-[calc(100vh-8rem)] ${focusBoard ? 'hidden' : ''}`}>
          {targeted && scene && (
            <TargetPanel
              self={myToken ?? selected}
              target={targeted}
              scene={scene}
              actor={myActor}
              items={myItems}
              onUse={(item, longRange) => {
                if (!activeActorId) return;
                // The card remembers who it was aimed at, so a spell save is
                // rolled by the target rather than by the caster - and carries
                // the range penalty the board can see and the server cannot.
                table.postCard(item.id, activeActorId, targeted.id, longRange);

                // An area spell also drops its own outline on the target, built
                // from the spell's own area so Fireball is a 20 ft circle
                // without anyone configuring one.
                const built = templateForSpell(
                  item.system.areaOfEffect as { shape?: string; size?: number; width?: number | null } | null,
                  { x: targeted.x + targeted.w / 2, y: targeted.y + targeted.h / 2 },
                  myToken
                    ? (Math.atan2(targeted.y - myToken.y, targeted.x - myToken.x) * 180) / Math.PI
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
              }}
              onClear={() => table.target(null)}
            />
          )}

          {selected && (
            <TokenHUD
              token={selected}
              isDM={Boolean(isDM)}
              canEdit={canEditSelected}
              onUpdate={(fields) => table.updateToken(selected.id, fields)}
              onDelete={() => table.deleteToken(selected.id)}
            />
          )}

          <SidebarTabs
            tabs={[
              { id: 'combat', label: 'Combat', node: <InitiativeTracker isDM={Boolean(isDM)} /> },
              ...(isDM && id
                ? [
                    { id: 'scene', label: 'Scene', node: <SceneManager campaignId={id} /> },
                  ]
                : []),
              ...(id
                ? [
                    {
                      id: 'journal',
                      label: 'Journal',
                      node: <JournalPanel campaignId={id} isDM={Boolean(isDM)} />,
                    },
                  ]
                : []),
            ]}
          />

          {/* Pinned below the tabs: the party is for glancing at, not working in. */}
          <Card className="shrink-0 p-3">
            <h2 className="mb-2 font-display text-sm text-ink-100">Party</h2>
            {party.length === 0 ? (
              <p className="text-xs text-ink-500">No characters assigned yet.</p>
            ) : (
              <ul className="space-y-1.5">
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
            <ChatPanel isDM={Boolean(isDM)} />
          </ErrorBoundary>
        </div>
      </div>

      {showHelp && <ShortcutHelp onClose={() => setShowHelp(false)} />}

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
          <span className="text-[10px] text-ink-600">
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
