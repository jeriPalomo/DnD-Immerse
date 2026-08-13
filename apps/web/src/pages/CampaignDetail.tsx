import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Alert, Badge, Button, Card, Spinner } from '../components/ui.js';
import { useAuth } from '../store/auth.js';
import { AvatarUpload } from '../components/AvatarUpload.js';
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
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [lastSession, setLastSession] = useState<LastSessionState>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      const [campaignRes, membersRes] = await Promise.all([
        api.get<{ campaign: Campaign; lastSession: LastSessionState }>(`/api/campaigns/${id}`),
        api.get<{ members: Member[] }>(`/api/campaigns/${id}/members`),
      ]);
      setCampaign(campaignRes.campaign);
      setLastSession(campaignRes.lastSession);
      setMembers(membersRes.members);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load campaign');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function removeMember(userId: string) {
    const leaving = userId === user?.id;
    if (!confirm(leaving ? 'Leave this campaign?' : 'Remove this player from the campaign?')) return;

    await api.delete(`/api/campaigns/${id}/members/${userId}`);
    if (leaving) navigate('/campaigns');
    else setMembers((current) => current.filter((m) => m.id !== userId));
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

      <header className="mt-4 mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-ink-100">{campaign.name}</h1>
          {campaign.description && (
            <p className="mt-2 max-w-prose text-sm text-ink-400">{campaign.description}</p>
          )}
        </div>
        <div className="flex items-center gap-3">
          <Badge tone={isDM ? 'dm' : 'player'}>{isDM ? 'Dungeon Master' : 'Player'}</Badge>
          <Link to={`/campaigns/${campaign.id}/table`}>
            <Button>Enter the table</Button>
          </Link>
        </div>
      </header>

      {campaign.bannerUrl && !isDM && (
        <img
          src={campaign.bannerUrl}
          alt=""
          className="mb-6 h-40 w-full rounded-xl border border-ink-700 object-cover"
        />
      )}

      {isDM && (
        <Card className="mb-6 p-5">
          <h2 className="mb-1 font-display text-lg text-ink-100">Rules edition</h2>
          <p className="mb-3 text-sm text-ink-400">
            Which equipment list the compendium offers. 2024 adds weapon mastery.
          </p>
          <select
            value={campaign.ruleset ?? '2014'}
            aria-label="Rules edition"
            onChange={async (e) => {
              const updated = await api.patch<{ campaign: Campaign }>(
                `/api/campaigns/${campaign.id}`,
                { ruleset: e.target.value },
              );
              setCampaign(updated.campaign);
            }}
            className="rounded-lg border border-ink-600 bg-ink-850 px-3 py-2 text-sm text-ink-100 focus:border-arcane-400 focus:outline-none"
          >
            <option value="2014">2014 rules (SRD 5.1)</option>
            <option value="2024">2024 rules (SRD 5.2)</option>
          </select>
          <p className="mt-2 text-xs text-ink-600">
            Spells and monsters come from the 2014 list either way — the 2024 SRD dataset does
            not publish them yet.
          </p>
        </Card>
      )}

      {isDM && (
        <Card className="mb-6 p-5">
          <h2 className="mb-1 font-display text-lg text-ink-100">Campaign banner</h2>
          <p className="mb-3 text-sm text-ink-400">Sets the mood on the campaign page.</p>
          <AvatarUpload
            url={campaign.bannerUrl}
            endpoint={`/api/campaigns/${campaign.id}/banner`}
            field="bannerUrl"
            label="Campaign banner"
            shape="banner"
            onUploaded={(bannerUrl) => setCampaign({ ...campaign, bannerUrl })}
          />
        </Card>
      )}

      {isDM && campaign.inviteCode && (
        <InviteCard campaignId={campaign.id} initialCode={campaign.inviteCode} />
      )}

      <Card className="p-5">
        <h2 className="font-display text-lg text-ink-100">
          At the table
          <span className="ml-2 text-sm font-normal text-ink-400">({members.length})</span>
        </h2>
        <ul className="mt-4 divide-y divide-ink-800">
          {members.map((member) => (
            <li key={member.id} className="flex items-center gap-3 py-3">
              <div className="flex size-9 items-center justify-center rounded-full bg-ink-700 text-sm font-semibold text-ink-200">
                {member.avatarUrl ? (
                  <img src={member.avatarUrl} alt="" className="size-9 rounded-full object-cover" />
                ) : (
                  member.displayName.slice(0, 2).toUpperCase()
                )}
              </div>
              <span className="flex-1 text-ink-100">{member.displayName}</span>
              <Badge tone={member.role === 'dm' ? 'dm' : 'player'}>
                {member.role === 'dm' ? 'DM' : 'Player'}
              </Badge>

              {/* The DM removes anyone; a player may only remove themselves. */}
              {member.role !== 'dm' && (isDM || member.id === user?.id) && (
                <button
                  onClick={() => void removeMember(member.id)}
                  className="text-xs text-ink-600 hover:text-red-400"
                  title={member.id === user?.id ? 'Leave this campaign' : `Remove ${member.displayName}`}
                >
                  {member.id === user?.id ? 'Leave' : 'Remove'}
                </button>
              )}
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

      <div className="mt-3 flex flex-wrap items-center gap-3">
        {session?.scene ? (
          <>
            {session.scene.mapImageUrl && (
              <img
                src={session.scene.mapImageUrl}
                alt=""
                className="h-14 w-24 shrink-0 rounded border border-ink-700 object-cover"
              />
            )}
            <div className="min-w-0">
              <div className="text-sm text-ink-100">{session.scene.name}</div>
              <div className="text-xs text-ink-500">
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

function InviteCard({ campaignId, initialCode }: { campaignId: string; initialCode: string }) {
  const [code, setCode] = useState(initialCode);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  async function rotate() {
    setBusy(true);
    try {
      const res = await api.post<{ inviteCode: string }>(
        `/api/campaigns/${campaignId}/invite/rotate`,
      );
      setCode(res.inviteCode);
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Card className="mb-6 p-5">
      <h2 className="font-display text-lg text-ink-100">Invite your players</h2>
      <p className="mt-1 text-sm text-ink-400">
        Share this code. Rotating it revokes any code you have already sent out.
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <code className="rounded-lg border border-ink-600 bg-ink-950 px-4 py-2.5 font-mono text-lg tracking-[0.3em] text-ember-300">
          {code}
        </code>
        <Button variant="secondary" size="sm" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
        <Button variant="ghost" size="sm" onClick={rotate} loading={busy}>
          Rotate
        </Button>
      </div>
    </Card>
  );
}
