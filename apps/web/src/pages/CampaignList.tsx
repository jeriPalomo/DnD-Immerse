import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Spinner, Textarea } from '../components/ui.js';
import { AvatarUpload } from '../components/AvatarUpload.js';
import { useCampaigns, type Campaign } from '../store/campaigns.js';
import { useAuth } from '../store/auth.js';

export default function CampaignList() {
  const { campaigns, loading, load, create, join } = useCampaigns();
  const { user, refresh } = useAuth();
  const [panel, setPanel] = useState<'none' | 'create' | 'join'>('none');

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="mx-auto max-w-5xl px-4 py-10">
      <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div className="flex items-center gap-4">
          <AvatarUpload
            url={user?.avatarUrl ?? null}
            endpoint="/api/auth/me/avatar"
            field="avatarUrl"
            label="Your avatar"
            onUploaded={() => void refresh()}
          />
          <div>
          <h1 className="font-display text-2xl font-bold text-ink-100">Your campaigns</h1>
          <p className="mt-1 text-sm text-ink-400">
            Run a story as Dungeon Master, or join one with an invite code.
          </p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => setPanel(panel === 'join' ? 'none' : 'join')}>
            Join with code
          </Button>
          <Button onClick={() => setPanel(panel === 'create' ? 'none' : 'create')}>
            New campaign
          </Button>
        </div>
      </header>

      {panel === 'create' && (
        <CreatePanel onDone={() => setPanel('none')} onCreate={create} />
      )}
      {panel === 'join' && <JoinPanel onDone={() => setPanel('none')} onJoin={join} />}

      {loading && campaigns.length === 0 ? (
        <Spinner />
      ) : campaigns.length === 0 ? (
        <EmptyState
          title="No campaigns yet"
          description="Create one to start building a world, or join a friend's table with the code they gave you."
          action={<Button onClick={() => setPanel('create')}>Create your first campaign</Button>}
        />
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2">
          {campaigns.map((campaign) => (
            <li key={campaign.id}>
              <Link to={`/campaigns/${campaign.id}`} className="block h-full">
                <Card className="h-full p-5 transition-colors hover:border-ink-600 hover:bg-ink-850">
                  <div className="flex items-start justify-between gap-3">
                    <h2 className="font-display text-lg font-semibold text-ink-100">
                      {campaign.name}
                    </h2>
                    <Badge tone={campaign.role === 'dm' ? 'dm' : 'player'}>
                      {campaign.role === 'dm' ? 'DM' : 'Player'}
                    </Badge>
                  </div>
                  {campaign.description && (
                    <p className="mt-2 line-clamp-3 text-sm text-ink-400">{campaign.description}</p>
                  )}
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CreatePanel({
  onCreate,
  onDone,
}: {
  onCreate: (name: string, description: string) => Promise<Campaign>;
  onDone: () => void;
}) {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const campaign = await onCreate(name, description);
      // Straight into setup rather than back to the grid: rules edition and
      // banner are decisions you make once, at the start.
      navigate(`/campaigns/${campaign.id}`, { state: { settings: true } });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create campaign');
      setBusy(false);
    }
  }

  return (
    <Card className="mb-8 p-5">
      <form onSubmit={submit} className="space-y-4">
        <h2 className="font-display text-lg text-ink-100">New campaign</h2>
        {error && <Alert>{error}</Alert>}
        <Field label="Name">
          <Input
            required
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Curse of Strahd"
          />
        </Field>
        <Field label="Description">
          <Textarea
            rows={3}
            maxLength={5000}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="The mists close in around Barovia..."
          />
        </Field>
        <div className="flex gap-2">
          <Button type="submit" loading={busy}>
            Create campaign
          </Button>
          <Button type="button" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

function JoinPanel({
  onJoin,
  onDone,
}: {
  onJoin: (code: string) => Promise<unknown>;
  onDone: () => void;
}) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await onJoin(code);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not join campaign');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mb-8 p-5">
      <form onSubmit={submit} className="space-y-4">
        <h2 className="font-display text-lg text-ink-100">Join a campaign</h2>
        {error && <Alert>{error}</Alert>}
        <Field label="Invite code" hint="Eight characters, from your DM.">
          <Input
            required
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="P2GGWD6V"
            className="font-mono tracking-[0.3em] uppercase"
            maxLength={8}
          />
        </Field>
        <div className="flex gap-2">
          <Button type="submit" loading={busy}>
            Join
          </Button>
          <Button type="button" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}
