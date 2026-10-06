export type ApiFailure = { code: string; message: string; status: number };

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { cache: "no-store", credentials: "same-origin", ...init });
  if (response.status === 401) {
    if (typeof window !== "undefined") window.location.assign("/login");
    throw { code: "UNAUTHENTICATED", message: "Your session has ended. Sign in again.", status: 401 } satisfies ApiFailure;
  }
  if (!response.ok) {
    let body: { error?: { code?: string; message?: string } } = {};
    try { body = await response.json(); } catch { /* A non-JSON failure remains visible. */ }
    throw { code: body.error?.code || "REQUEST_FAILED", message: body.error?.message || `Request failed (${response.status}).`, status: response.status } satisfies ApiFailure;
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export function messageFrom(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) return String(error.message);
  return "Something went wrong. Please try again.";
}

export function isDenied(error: unknown): boolean {
  return typeof error === "object" && error !== null && "status" in error && error.status === 403;
}
