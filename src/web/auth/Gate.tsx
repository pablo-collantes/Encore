import { lazy, Suspense, useEffect, useState } from "react";
import type { Me } from "@shared/api";
import { fetchMe, safeNext } from "./api";
import { ForgotPasswordPage, LoadFailed, LoginPage, ResetPasswordPage, SetPasswordPage, Splash } from "./AuthPages";

// The app lives in ../app/AuthedApp.tsx and is emitted under /protected/, which
// the Worker serves only to a valid session. This lazy import is the public
// bundle's only reference to it, and it runs after sign-in.
const AuthedApp = lazy(() => import("../app/AuthedApp").catch(() => ({ default: LoadFailed })));

type Screen =
  | { me: Me }
  | { page: "login"; next: string; offline?: boolean }
  | { page: "forgot" }
  | { page: "set-password" }
  | { page: "reset-password" };

// Invite and reset links carry their token in the URL fragment, which never
// reaches a server, a Referer or a chat app's link preview. Read it once, then
// drop it from the address bar and history. It is spent only on form submit.
const TOKEN_PAGES = ["/set-password", "/reset-password"];
const START = (() => {
  const path = location.pathname.replace(/\/+$/, "") || "/";
  const isTokenPage = TOKEN_PAGES.includes(path);
  const token = isTokenPage ? location.hash.slice(1) : "";
  if (isTokenPage && location.hash) history.replaceState(null, "", path);
  return { path, token };
})();

/** Where a visitor sent to sign-in was headed (kept in /login?next=…). */
function loginNext(path: string): string {
  return path === "/login" ? safeNext(new URLSearchParams(location.search).get("next")) : safeNext(location.pathname + location.search);
}

function toLogin(path: string, offline?: boolean): Screen {
  const next = loginNext(path);
  if (path !== "/login") history.replaceState(null, "", `/login${next !== "/" ? `?next=${encodeURIComponent(next)}` : ""}`);
  return { page: "login", next, offline };
}

// Decides the first screen: { me } opens the app, { page } shows a public page.
async function boot(): Promise<Screen> {
  const { path } = START;
  // Reachable with or without a session: the link decides, not the cookie.
  if (path === "/set-password") return { page: "set-password" };
  if (path === "/reset-password") return { page: "reset-password" };

  let me: Me | null;
  try {
    me = await fetchMe();
  } catch {
    return path === "/forgot-password" ? { page: "forgot" } : toLogin(path, true);
  }
  if (me) {
    if (path === "/login") history.replaceState(null, "", loginNext(path));
    else if (path === "/forgot-password") history.replaceState(null, "", "/");
    return { me };
  }
  if (path === "/forgot-password") return { page: "forgot" };
  return toLogin(path);
}

let booting: Promise<Screen> | undefined; // one boot per page load, even under StrictMode

export function Gate() {
  const [screen, setScreen] = useState<Screen | null>(null);

  useEffect(() => {
    let live = true;
    (booting ??= boot()).then((s) => live && setScreen(s));
    return () => {
      live = false;
    };
  }, []);

  if (!screen) return <Splash />;
  if ("me" in screen) {
    return (
      <Suspense fallback={<Splash />}>
        <AuthedApp me={screen.me} />
      </Suspense>
    );
  }
  switch (screen.page) {
    case "set-password":
      return <SetPasswordPage token={START.token} />;
    case "reset-password":
      return <ResetPasswordPage token={START.token} />;
    case "forgot":
      return <ForgotPasswordPage />;
    default:
      return <LoginPage next={screen.next} offline={screen.offline} />;
  }
}
