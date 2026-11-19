/** First-run onboarding flag (per browser / desktop-app profile). */
export const ONBOARDED_KEY = "nexus.onboarded.v1";

export function isOnboarded() {
  try {
    return localStorage.getItem(ONBOARDED_KEY) === "1";
  } catch {
    return true; // storage blocked: never trap the user on the welcome screen
  }
}

export function finishOnboarding() {
  try {
    localStorage.setItem(ONBOARDED_KEY, "1");
  } catch { /* ignore */ }
}
