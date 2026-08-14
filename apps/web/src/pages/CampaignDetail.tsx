import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { Alert, Badge, Button, Card, Spinner } from '../components/ui.js';
import { useAuth } from '../store/auth.js';
import { CampaignSettings } from '../components/campaign/CampaignSettings.js';
import { api } from '../lib/api.js';
import type { Campaign, Member } from '../store/campaigns.js';

/** Where the table left off, derived server-side so it cannot go stale. */
type LastSessionState = {
  scene: { id: string; name: string; mapImageUrl: string | null } | null;
  combat: { round: number } | null;
} | null;

export default function CampaignDetail() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [lastSession, setLastSession] = useState<LastSessionState>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // A campaign that has just been created opens straight into its settings, so
  // the DM sets it up rather than hunting for the gear.
  const [settingsOpen, setSettingsOpen] = useState(
    Boolean((location.state as { settings?: boolean } | null)?.settings),
  );

  // `loading` is "nothing to show yet", never "a request is in flight" - a
  // refetch after a rename must not swap the page for a spinner and throw the
  // scroll position away. Tracked in a ref because `load` closes over `id`
  // only, so a state read here would be a render behind.
  const loadedId = useRef<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(loadedId.current !== id);
    try {
      const [campaignRes, membersRes] = await Promise.all([
        api.get<{ campaign: Campaign; lastSession: LastSessionState }>(`/api/campaigns/${id}`),
        api.get<{ members: Member[] }>(`/api/campaigns/${id}/members`),
      ]);
      setCampaign(campaignRes.campaign);
      setLastSession(campaignRes.lastSession);
      setMembers(membersRes.members);
      loadedId.current = id;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load campaign');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function leave() {
    if (!confirm('Leave this campaign?')) return;
    await api.delete(`/api/campaigns/${id}/members/${user?.id}`);
    navigate('/campaigns');
  }

  if (loading) return <Spinner />;
  if (error) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10">
        <Alert>{error}</Alert>
        <Link to="/campaigns" className="mt-4 inline-block text-sm text-ember-400 hover:underline">
          Back to campaigns
        </Link>
      </div>
    );
  }
  if (!campaign) return null;

  const isDM = campaign.role === 'dm';

  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <Link to="/campaigns" className="text-sm text-ink-400 hover:text-ink-200">
        &larr; All campaigns
      </Link>

      {/* Code and gear pinned to the top corner; entering the table is the
          bigger decision and gets its own line under them. */}
      <div className="mt-4 flex items-start justify-between gap-4">
        <h1 className="font-display text-2xl font-bold text-ink-100">{campaign.name}</h1>
        <div className="flex shrink-0 items-center gap-2">
          {/* The invite code is a credential; the server sends it to the DM
              alone, so this is never a player's to read. */}
          {campaign.inviteCode && <InviteCode code={campaign.inviteCode} />}
          {isDM ? (
            <button
              onClick={() => setSettingsOpen(true)}
              aria-label="Campaign settings"
              title="Campaign settings"
              className="rounded-lg border border-ink-700 px-2.5 py-2 text-lg leading-none text-ink-400 transition-colors hover:border-ink-600 hover:text-ink-100"
            >
              ⚙
            </button>
          ) : (
            <Badge tone="player">Player</Badge>
          )}
        </div>
      </div>

      <header className="mt-2 mb-8 flex flex-wrap items-end justify-between gap-4">
        {campaign.description ? (
          <p className="max-w-prose text-sm text-ink-400">{campaign.description}</p>
        ) : (
          <span />
        )}
        <Link to={`/campaigns/${campaign.id}/table`} className="shrink-0">
          <Button>Enter the table</Button>
        </Link>
      </header>

      {campaign.bannerUrl && (
        <img
          src={campaign.bannerUrl}
          alt=""
          className="mb-6 h-40 w-full rounded-xl border border-ink-700 object-cover"
        />
      )}

      <Card className="p-5">
        <h2 className="font-display text-lg text-ink-100">
          On the Journey&hellip;
          <span className="ml-2 text-sm font-normal text-ink-400">({members.length})</span>
        </h2>
        <ul className="mt-4 divide-y divide-ink-800">
          {members.map((member) => (
            <li key={member.id} className="flex items-center gap-3 py-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-ink-700 text-sm font-semibold text-ink-200">
                {member.avatarUrl ? (
                  <img src={member.avatarUrl} alt="" className="size-9 rounded-full object-cover" />
                ) : (
                  member.displayName.slice(0, 2).toUpperCase()
                )}
              </div>

              <div className="min-w-0 flex-1">
                <div className="truncate text-ink-100">{member.displayName}</div>
                {member.characters.length > 0 && (
                  <div className="truncate text-sm text-ink-400">
                    {member.characters.map((character, index) => (
                      <span key={character.id}>
                        {index > 0 && ', '}
                        <Link
                          to={`/characters/${character.id}`}
                          state={{ path: location.pathname, label: 'Back to the campaign' }}
                          className="hover:text-ember-300 hover:underline"
                        >
                          {character.name}
                        </Link>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <Badge tone={member.role === 'dm' ? 'dm' : 'player'}>
                {member.role === 'dm' ? 'DM' : 'Player'}
              </Badge>
            </li>
          ))}
        </ul>
      </Card>

      <LastSession
        campaignId={campaign.id}
        isDM={isDM}
        recap={campaign.recap ?? ''}
        session={lastSession}
        onRecap={(recap) => setCampaign({ ...campaign, recap })}
      />

      {/* The DM removes players from settings; a player's only membership
          control is getting out, so it lives here rather than in the roster. */}
      {!isDM && (
        <button
          onClick={() => void leave()}
          className="mt-6 text-xs text-ink-600 hover:text-red-400"
        >
          Leave this campaign
        </button>
      )}

      {settingsOpen && isDM && (
        <CampaignSettings
          campaign={campaign}
          members={members}
          onChange={setCampaign}
          onMembersChanged={() => void load()}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}

/**
 * Where the campaign left off, and what happened.
 *
 * Two halves on purpose: the scene and the open combat are derived from the
 * live data so they cannot go stale, and the recap is the DM's own words,
 * because a summary of the chat log reads back the dice rather than the story.
 */
function LastSession({
  campaignId,
  isDM,
  recap,
  session,
  onRecap,
}: {
  campaignId: string;
  isDM: boolean;
  recap: string;
  session: LastSessionState;
  onRecap: (recap: string) => void;
}) {
  const [draft, setDraft] = useState(recap);
  const [saved, setSaved] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => setDraft(recap), [recap]);

  // Debounced, like the sheet: a recap is typed, not submitted.
  function edit(next: string) {
    setDraft(next);
    setSaved(false);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      await api.patch(`/api/campaigns/${campaignId}`, { recap: next });
      onRecap(next);
      setSaved(true);
    }, 700);
  }

  return (
    <Card className="mt-6 p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-display text-lg text-ink-100">Last session</h2>
        {isDM && !saved && <span className="text-xs text-ink-600">Saving…</span>}
      </div>

      {/* The map, at a size you can actually recognise a room from, with the
          scene named underneath it. */}
      <div className="mt-3">
        {session?.scene ? (
          <>
            {session.scene.mapImageUrl ? (
              <img
                src={session.scene.mapImageUrl}
                alt=""
                className="h-48 w-full rounded-lg border border-ink-700 object-cover"
              />
            ) : (
              // A scene with no map still has a name worth reading.
              <div className="flex h-24 w-full items-center justify-center rounded-lg border border-dashed border-ink-700 text-xs text-ink-600">
                No map uploaded
              </div>
            )}
            <div className="mt-3 text-center">
              <div className="font-display text-xl text-ink-100">{session.scene.name}</div>
              <div className="mt-0.5 text-xs text-ink-500">
                {session.combat
                  ? `Combat still open — round ${session.combat.round}`
                  : 'No combat in progress'}
              </div>
            </div>
          </>
        ) : (
          <p className="text-sm text-ink-500">No scene is live yet.</p>
        )}
      </div>

      {isDM ? (
        <textarea
          value={draft}
          onChange={(e) => edit(e.target.value)}
          rows={4}
          aria-label="Session recap"
          placeholder="What happened last time? The party is reading this before they sit down…"
          className="mt-3 w-full resize-y rounded-lg border border-ink-700 bg-ink-850 px-3 py-2 text-sm text-ink-200 placeholder:text-ink-600 focus:border-arcane-400 focus:outline-none"
        />
      ) : recap ? (
        <p className="mt-3 text-sm whitespace-pre-wrap text-ink-300">{recap}</p>
      ) : (
        <p className="mt-3 text-sm text-ink-600">The DM has not written a recap yet.</p>
      )}
    </Card>
  );
}

/**
 * The invite code, in the page header.
 *
 * Clicking it copies — the old card had a separate Copy button, and the code is
 * only ever there to be handed to somebody. Rotating moved into settings, where
 * revoking a code you have already sent reads as the decision it is.
 */
function InviteCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      onClick={async () => {
        await navigator.clipboard.writeText(code);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      title="Invite code — click to copy"
      className="rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 font-mono text-sm tracking-[0.2em] text-ember-300 transition-colors hover:border-ember-500"
    >
      {copied ? 'Copied' : code}
    </button>
  );
}
