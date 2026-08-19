import { useTable } from '../../store/table.js';

/**
 * The whole fight's state at a glance.
 *
 * "How is this going" is a question about every enemy at once, and answering it
 * by clicking each token in turn loses the shape of the encounter. The numbers
 * are already in the DM's payload - `hp` and `maxHp` are redacted for everyone
 * else where the row becomes a payload - so this reads the store and adds no
 * new channel.
 *
 * Filtered on `disposition`, never on `ownerUserId`. They are separate signals:
 * disposition is what tells friend from foe, while `ownerUserId` decides HP
 * redaction, so a friendly NPC the DM runs is green on the board and does not
 * belong on a list of things trying to kill the party.
 */
export function EnemyHealth() {
  const { tokens } = useTable();

  const hostiles = tokens.filter(
    (token) => token.disposition === 'hostile' && token.layer !== 'gm' && token.maxHp,
  );

  if (hostiles.length === 0) return null;

  return (
    <div className="rounded-lg border border-ink-800 p-2">
      <h3 className="mb-1.5 text-[10px] tracking-wider text-ink-500 uppercase">
        Enemies <span className="text-ink-600">{hostiles.length}</span>
      </h3>

      <ul className="space-y-1">
        {hostiles.map((token) => {
          const hp = token.hp ?? 0;
          const max = token.maxHp ?? 1;
          const percent = Math.max(0, Math.min(100, (hp / max) * 100));
          const down = hp <= 0;

          return (
            <li key={token.id} className="flex items-center gap-2">
              <div className="size-5 shrink-0 overflow-hidden rounded border border-ink-800 bg-ink-850">
                {token.imageUrl ? (
                  <img src={token.imageUrl} alt="" loading="lazy" className="size-full object-cover" />
                ) : (
                  <div className="flex size-full items-center justify-center text-[8px] text-ink-600">
                    {(token.name || '?').slice(0, 1).toUpperCase()}
                  </div>
                )}
              </div>

              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className={`truncate text-xs ${down ? 'text-ink-600 line-through' : 'text-ink-300'}`}>
                    {token.name || 'Creature'}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-ink-500">
                    {hp}/{max}
                  </span>
                </div>
                <div className="mt-0.5 h-1 overflow-hidden rounded-full bg-ink-950">
                  <div
                    className={`h-full ${percent <= 50 ? 'bg-ember-500' : 'bg-emerald-600'}`}
                    style={{ width: `${percent}%` }}
                  />
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
