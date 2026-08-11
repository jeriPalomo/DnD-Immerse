import { useState } from 'react';
import { api } from '../lib/api.js';

/**
 * Portrait upload, used for both the signed-in user's avatar and a campaign's
 * banner. Both endpoints already existed server-side with nothing able to
 * reach them, so every avatar was permanently a letter in a grey box.
 */
export function AvatarUpload({
  url,
  endpoint,
  field,
  label,
  shape = 'circle',
  onUploaded,
}: {
  url: string | null;
  endpoint: string;
  /** Key the endpoint returns the new URL under. */
  field: 'avatarUrl' | 'bannerUrl' | 'portraitUrl';
  label: string;
  shape?: 'circle' | 'banner';
  onUploaded: (url: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    try {
      const res = await api.upload<Record<string, string>>(endpoint, file);
      onUploaded(res[field]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  }

  const isBanner = shape === 'banner';

  return (
    <div>
      <label
        className={`group relative block cursor-pointer overflow-hidden border border-ink-700 bg-ink-800 ${
          isBanner ? 'h-28 w-full rounded-lg' : 'size-16 rounded-full'
        }`}
      >
        {url ? (
          <img src={url} alt="" className="size-full object-cover" />
        ) : (
          <div className="flex size-full items-center justify-center text-xs text-ink-500">
            {isBanner ? 'No banner' : 'No image'}
          </div>
        )}

        <input
          type="file"
          accept="image/*"
          className="sr-only"
          aria-label={label}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void upload(file);
          }}
        />
        <span className="absolute inset-0 flex items-center justify-center bg-black/60 text-xs text-ink-100 opacity-0 transition-opacity group-hover:opacity-100">
          {busy ? 'Uploading…' : 'Change'}
        </span>
      </label>

      {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
    </div>
  );
}
