// Optional backend base URL (Settings > Backend). Empty = same origin (default).
const KEY = "nexus.backendUrl";

export function getApiBase(): string {
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

export function setApiBase(url: string) {
  try {
    if (url) localStorage.setItem(KEY, url.replace(/\/$/, ""));
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable: keep default */
  }
}
