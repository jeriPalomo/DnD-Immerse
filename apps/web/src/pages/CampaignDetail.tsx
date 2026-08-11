import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Alert, Badge, Button, Card, Spinner } from '../components/ui.js';
import { AvatarUpload } from '../components/AvatarUpload.js';
import { api } from '../lib/api.js';
import type { Campaign, Member } from '../store/campaigns.js';

export default function CampaignDetail() {
  const { id } = useParams<{ id: string }>();
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      const [campaignRes, membersRes] = await Promise.all([
        api.get<{ campaign: Campaign }>(`/api/campaigns/${id}`),
        api.get<{ members: Member[] }>(`/api/campaigns/${id}/members`),
      ]);
      setCampaign(campaignRes.campaign);
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
            </li>
          ))}
        </ul>
      </Card>

      <Card className="mt-6 border-dashed p-5">
        <h2 className="font-display text-lg text-ink-100">Coming next</h2>
        <p className="mt-2 text-sm text-ink-400">
          The battle map with tokens, walls and dynamic vision arrives in the phases after this one.
        </p>
      </Card>
    </div>
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
