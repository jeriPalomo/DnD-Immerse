export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly issues?: { path: string; message: string }[],
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    // Session cookie must ride along on every call.
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new ApiError(response.status, payload.error ?? 'Request failed', payload.issues);
  }
  return payload as T;
}

export const api = {
  get: <T,>(path: string) => request<T>('GET', path),
  post: <T,>(path: string, body?: unknown) => request<T>('POST', path, body),
  patch: <T,>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  delete: <T,>(path: string) => request<T>('DELETE', path),

  async upload<T>(path: string, file: File): Promise<T> {
    const form = new FormData();
    form.append('file', file);

    const response = await fetch(path, { method: 'POST', credentials: 'same-origin', body: form });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new ApiError(response.status, payload.error ?? 'Upload failed');
    return payload as T;
  },
};
