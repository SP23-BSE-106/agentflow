import { NextRequest, NextResponse } from "next/server";

import { getDb } from "@/lib/mongo/mongo";
import { signJwt, setSessionToken, SESSION_MAX_AGE } from "@/lib/auth/jwt";

const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v2/userinfo";

function getGoogleRedirectUri(request: NextRequest, envValue?: string) {
  const requestUrl = new URL(request.url);
  const forwardedProto = request.headers.get("x-forwarded-proto");
  const forwardedHost = request.headers.get("x-forwarded-host");

  const origin = forwardedProto && forwardedHost
    ? `${forwardedProto.split(",")[0].trim()}://${forwardedHost.split(",")[0].trim()}`
    : requestUrl.origin;

  return envValue?.trim() || `${origin}/api/auth/google/callback`;
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    return NextResponse.json({ error }, { status: 400 });
  }

  if (!code) {
    return NextResponse.json({ error: "Missing code" }, { status: 400 });
  }

  // Read state cookie from request
  const cookieHeader = request.headers.get("cookie") || "";
  const match = cookieHeader
    .split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith("google_oauth_state="));
  const expectedState = match ? decodeURIComponent(match.split("=")[1]) : null;

  if (!state || !expectedState || expectedState !== state) {
    return NextResponse.json({ error: "Invalid OAuth state" }, { status: 400 });
  }

  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI } =
    process.env as Record<string, string | undefined>;

  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return NextResponse.json(
      { error: "Missing Google OAuth environment variables" },
      { status: 500 }
    );
  }

  const redirectUri = getGoogleRedirectUri(request, GOOGLE_REDIRECT_URI);

  const verifierMatch = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("google_oauth_verifier="));
  const codeVerifier = verifierMatch ? decodeURIComponent(verifierMatch.split("=")[1]) : null;
  if (!codeVerifier) {
    return NextResponse.json({ error: "Missing OAuth verifier — restart Google sign-in" }, { status: 400 });
  }

  const tokenRes = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code_verifier: codeVerifier,
    }).toString(),
  });

  const tokenJson = (await tokenRes.json().catch(() => ({}))) as {
    access_token?: string;
    error?: string;
  };

  if (!tokenRes.ok || !tokenJson.access_token) {
    return NextResponse.json(
      { error: tokenJson.error || "Failed to exchange token" },
      { status: 400 }
    );
  }

  const accessToken = tokenJson.access_token;

  const profileRes = await fetch(GOOGLE_USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  const profile = (await profileRes.json().catch(() => ({}))) as {
    id?: string;
    email?: string;
    name?: string;
    verified_email?: boolean;
  };

  const email = (profile.email || "").trim().toLowerCase();
  const fullName = (profile.name || "").trim();

  if (!email) {
    return NextResponse.json(
      { error: "Google profile missing email" },
      { status: 400 }
    );
  }

  // An unverified Google email must never become a verified AgentFlow
  // account. Google's userinfo email is normally verified; check anyway.
  if (profile.verified_email !== true) {
    return NextResponse.json(
      { error: "Google could not confirm this email address. Use a verified Google account." },
      { status: 400 }
    );
  }

  const db = await getDb();
  const users = db.collection("users");

  const existing = await users.findOne<{ _id: string; email: string; passwordHash?: string; oauth?: { provider?: string } }>({
    email,
  });

  let userId: string;
  if (!existing) {
    await users.insertOne({
      email,
      fullName: fullName || undefined,
      createdAt: new Date(),
      emailVerified: true,
      tokenVersion: 0,
      trialEndsAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      subscriptionPlan: 'free_trial',
      subscriptionStatus: 'trialing',
      oauth: { provider: "google", subject: profile.id || null },
    });

    const created = await users.findOne<{ _id: string }>({ email });
    if (!created) return NextResponse.json({ error: "Could not create account" }, { status: 500 });
    userId = String(created._id);
  } else if (existing.passwordHash && existing.oauth?.provider !== "google") {
    // Never silently link a Google login onto a password account: whoever
    // controls that Google account would take over the AgentFlow account.
    return NextResponse.json(
      { error: "This email already has a password account. Sign in with your password first, then link Google from Settings." },
      { status: 409 }
    );
  } else {
    userId = String(existing._id);
    if (fullName) {
      await users.updateOne(
        { email },
        { $set: { fullName, "oauth.lastLoginAt": new Date() } }
      );
    }
  }

  const current = await users.findOne<{ tokenVersion?: number }>({ email });
  const jwt = signJwt(
    { sub: userId, email, fullName: fullName || undefined, tokenVersion: current?.tokenVersion ?? 0 },
    SESSION_MAX_AGE
  );
  await setSessionToken(jwt);

  const res = NextResponse.redirect(new URL("/dashboard", request.url));
  // Clear one-time state cookie
  res.cookies.set("google_oauth_verifier", "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  res.cookies.set("google_oauth_state", "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });

  return res;
}


