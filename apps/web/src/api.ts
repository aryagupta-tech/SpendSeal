export class ApiError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const method = (options.method ?? "GET").toUpperCase();
  const csrf = document.cookie.split(";").map((value) => value.trim()).find((value) => value.startsWith("agentrail_csrf="))?.slice("agentrail_csrf=".length);
  const response = await fetch(path, {
    ...options,
    credentials: "include",
    headers: { "content-type": "application/json", ...(method !== "GET" && csrf ? { "x-csrf-token": decodeURIComponent(csrf) } : {}), ...(options.headers ?? {}) },
  });
  const body = await response.json().catch(() => ({})) as { error?: { code?: string; message?: string } };
  if (!response.ok) throw new ApiError(body.error?.code ?? "REQUEST_FAILED", body.error?.message ?? "Request failed");
  return body as T;
}

export const money = (paise: number) => new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: Math.abs(paise) % 100 === 0 ? 0 : 2,
  maximumFractionDigits: 2,
}).format(paise / 100);
export const shortId = (value: string) => `${value.slice(0, 8)}…${value.slice(-4)}`;
export const dateTime = (value: string) => new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
