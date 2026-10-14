import type { TransactionalEmail, TransactionalEmailProvider } from "@rakazo/adapter-kit";
import { emailAllowed, isMessagingEmail, parseAllowlist, signupPolicyFromEnv } from "@rakazo/core";
import { bootstrapUserSpace, type PrismaClient } from "@rakazo/db";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { bearer, magicLink, organization } from "better-auth/plugins";

export interface AuthEnv {
  secret: string;
  baseURL: string;
  webOrigin: string;
  signupsEnabled: string | undefined;
  signupAllowlist: string | undefined;
  extraOrigins?: string[];
  /** Better Auth rate limiting. Unset: Better Auth's default (on when NODE_ENV=production). Tests turn it off. */
  rateLimitEnabled?: boolean;
  email?: TransactionalEmailProvider;
  onEmailError?: (error: unknown) => void;
  beforeDeleteUser?: (userId: string) => Promise<void>;
}

export async function resolveSignupPolicy(
  prisma: Pick<PrismaClient, "deploymentSettings">,
  env: Pick<AuthEnv, "signupsEnabled" | "signupAllowlist">,
): Promise<{ enabled: boolean; allowlist: string[] }> {
  const settings = await prisma.deploymentSettings.findUnique({
    where: { id: "default" },
    select: { signupsEnabled: true, signupAllowlist: true, signupPolicyInitialized: true },
  });
  if (settings?.signupPolicyInitialized) {
    return {
      enabled: settings.signupsEnabled,
      allowlist: parseAllowlist(settings.signupAllowlist),
    };
  }
  return signupPolicyFromEnv(env);
}

export function createAuth(prisma: PrismaClient, env: AuthEnv) {
  return betterAuth({
    appName: "Rakijazios",
    secret: env.secret,
    baseURL: env.baseURL,
    trustedOrigins: buildTrustedOrigins(env),
    database: prismaAdapter(prisma, { provider: "postgresql" }),
    // Self-host: friends + host retries shouldn't lock out after a few attempts.
    rateLimit: {
      ...(env.rateLimitEnabled === undefined ? {} : { enabled: env.rateLimitEnabled }),
      window: 60,
      max: 60,
    },
    emailAndPassword: {
      enabled: true,
      // Signup policy is mutable deployment state, so the request hook below
      // enforces it instead of freezing an environment value at process start.
      disableSignUp: false,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: 60 * 60,
      sendResetPassword: env.email
        ? async ({ user, url }) => {
            // Keep the response timing generic. Production providers track and retry the promise,
            // while the composition root drains accepted delivery during graceful shutdown.
            void env.email
              ?.send(passwordResetEmail(user, url))
              .catch((error) => env.onEmailError?.(error));
          }
        : undefined,
    },
    emailVerification: {
      sendOnSignIn: true,
      autoSignInAfterVerification: false,
      sendVerificationEmail: env.email
        ? async ({ user, url }) => {
            const verificationUrl = new URL(url);
            verificationUrl.searchParams.set(
              "callbackURL",
              new URL("/sign-in", env.webOrigin).href,
            );
            await env.email!.send(verificationEmail(user.email, verificationUrl.href));
          }
        : undefined,
    },
    user: {
      deleteUser: {
        enabled: true,
        beforeDelete: async (user) => {
          await env.beforeDeleteUser?.(user.id);
          const memberships = await prisma.member.findMany({
            where: { userId: user.id },
            select: {
              organizationId: true,
              organization: { select: { members: { select: { userId: true } } } },
            },
          });
          const personalOrganizationIds = memberships
            .filter(({ organization }) =>
              organization.members.every((member) => member.userId === user.id),
            )
            .map(({ organizationId }) => organizationId);

          await prisma.$transaction([
            prisma.deploymentSettings.updateMany({
              where: { ownerUserId: user.id },
              data: { ownerUserId: null },
            }),
            // Messaging identities are deliberately FK-free, so clear them
            // here or the unique address would point at a deleted bot forever.
            prisma.messagingIdentity.deleteMany({
              where: { userId: user.id },
            }),
            prisma.organization.deleteMany({
              where: { id: { in: personalOrganizationIds } },
            }),
          ]);
        },
      },
    },
    plugins: [
      bearer(),
      organization({
        allowUserToCreateOrganization: false,
        creatorRole: "owner",
      }),
      ...(env.email
        ? [
            magicLink({
              expiresIn: 60 * 15,
              sendMagicLink: async ({ email, url }) => {
                // Session cookie is host-bound. Keep verify + callback on the same
                // canonical origin (WEB_ORIGIN / BETTER_AUTH_URL) or login is lost
                // after redirect (e.g. 192.168.x ↔ 127.0.0.1).
                const aligned = alignMagicLinkToOrigin(url, env.webOrigin || env.baseURL);
                // Await delivery so the client sees Resend/SMTP failures instead of a fake OK.
                try {
                  await env.email!.send(magicLinkEmail(email, aligned));
                } catch (error) {
                  env.onEmailError?.(error);
                  const message =
                    error instanceof Error ? error.message : "Could not send magic link email";
                  throw new APIError("BAD_REQUEST", { message });
                }
              },
            }),
          ]
        : []),
    ],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        for (const value of [ctx.body?.email, ctx.body?.newEmail]) {
          if (typeof value === "string" && isMessagingEmail(value)) {
            throw new APIError("BAD_REQUEST", { message: "Email is not available" });
          }
        }
        let policy =
          ctx.path === "/sign-up/email" ||
          ctx.path === "/sign-in/email" ||
          ctx.path === "/sign-in/magic-link"
            ? await resolveSignupPolicy(prisma, env)
            : undefined;
        if (ctx.path === "/sign-in/magic-link") {
          if (!env.email) {
            throw new APIError("BAD_REQUEST", { message: "Magic link sign-in is not configured" });
          }
          const email = String(ctx.body?.email ?? "")
            .trim()
            .toLowerCase();
          // Existing accounts (including password users) always get a link.
          // New emails still go through the same signup policy as /sign-up/email.
          const existing = email
            ? await prisma.user.findFirst({ where: { email } })
            : null;
          if (!existing) {
            if (!policy?.enabled) {
              throw new APIError("BAD_REQUEST", { message: "Registration is closed" });
            }
            if (!emailAllowed(email, policy.allowlist)) {
              throw new APIError("BAD_REQUEST", { message: "Email is not allowed to register" });
            }
            if (policy.allowlist.length > 0 && !env.email) {
              throw new APIError("BAD_REQUEST", {
                message: "Registration requires email delivery",
              });
            }
          }
        }
        if (ctx.path === "/sign-up/email") {
          if (!policy?.enabled) {
            throw new APIError("BAD_REQUEST", { message: "Registration is closed" });
          }
          if (!emailAllowed(String(ctx.body?.email ?? ""), policy.allowlist)) {
            throw new APIError("BAD_REQUEST", { message: "Email is not allowed to register" });
          }
          if (policy.allowlist.length > 0 && !env.email) {
            throw new APIError("BAD_REQUEST", { message: "Registration requires email delivery" });
          }
        }
        // Return a request-local override; mutating the shared auth options
        // would leak a concurrent request's policy into another signup.
        return {
          context: {
            context: {
              ...(policy
                ? {
                    options: {
                      emailAndPassword: { requireEmailVerification: policy.allowlist.length > 0 },
                    },
                  }
                : {}),
              internalAdapter: {
                ...ctx.context.internalAdapter,
                // Authorize at lookup: bearer conversion happens after before
                // hooks, and auth mutations also read sessions through here.
                findSession: async (token: string) => {
                  const session = await ctx.context.internalAdapter.findSession(token);
                  if (!session || isMessagingEmail(session.user.email)) return null;
                  if (session.user.emailVerified) return session;
                  policy ??= await resolveSignupPolicy(prisma, env);
                  return policy.allowlist.length === 0 ? session : null;
                },
              },
            },
          },
        };
      }),
    },
    databaseHooks: {
      session: {
        create: {
          before: async (session, ctx) => {
            // The auth adapter can still be inside the signup transaction.
            const user = await ctx?.context.internalAdapter.findUserById(session.userId);
            const policy = await resolveSignupPolicy(prisma, env);
            if (
              !user ||
              isMessagingEmail(user.email) ||
              (!user.emailVerified && policy.allowlist.length > 0)
            ) {
              throw new APIError("FORBIDDEN", { message: "Email verification required" });
            }
            // Unverified signup must not provision resources or claim the
            // deployment owner. Bootstrap only at the first admitted session.
            const membership = await prisma.spaceMember.findFirst({ where: { userId: user.id } });
            if (!membership) {
              if (!policy.enabled || !emailAllowed(user.email, policy.allowlist)) {
                throw new APIError("FORBIDDEN", { message: "Registration is closed" });
              }
              await bootstrapUserSpace(prisma, user, env);
            }
          },
        },
      },
      user: {
        create: {
          before: async (user) => {
            if (isMessagingEmail(user.email)) {
              throw new APIError("BAD_REQUEST", { message: "Email is not available" });
            }
            // Magic-link sign-up arrives without a name: give the account a unique @handle
            // from the email local part (qa3@x → qa3, then qa3_2, …) so it never shows "?".
            if (!String(user.name ?? "").trim()) {
              const name = await uniqueHandle(user.email, async (candidate) =>
                Boolean(
                  await prisma.user.findFirst({
                    where: { name: { equals: candidate, mode: "insensitive" } },
                    select: { id: true },
                  }),
                ),
              );
              return { data: { ...user, name } };
            }
          },
        },
        update: {
          before: async (user) => {
            if (user.email && isMessagingEmail(user.email)) {
              throw new APIError("BAD_REQUEST", { message: "Email is not available" });
            }
          },
        },
      },
    },
  });
}

const HANDLE_MAX = 24;

/** "Qa.Three+test@x" → "qa_three". Letters, digits and _ only; 3–24 chars; never empty. */
export function handleFromEmail(email: string): string {
  const local = String(email ?? "").split("@")[0]!.split("+")[0]!;
  let base = local
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, HANDLE_MAX);
  if (base.length < 3) base = `user${base ? `_${base}` : ""}`;
  return base;
}

/** First free handle: base, base_2 … base_99, then base_<random>. `taken` is case-insensitive. */
export async function uniqueHandle(
  email: string,
  taken: (candidate: string) => Promise<boolean>,
  random: () => string = () => Math.random().toString(36).slice(2, 8),
): Promise<string> {
  const base = handleFromEmail(email);
  if (!(await taken(base))) return base;
  for (let n = 2; n < 100; n++) {
    const suffix = `_${n}`;
    const candidate = base.slice(0, HANDLE_MAX - suffix.length) + suffix;
    if (!(await taken(candidate))) return candidate;
  }
  const suffix = `_${random()}`;
  return base.slice(0, HANDLE_MAX - suffix.length) + suffix;
}

export function verificationEmail(email: string, url: string): TransactionalEmail {
  return {
    to: email,
    subject: "Verify your Rakijazios email",
    text: `Verify your email, then return to Rakijazios to sign in:\n\n${url}\n\nThis link expires in one hour. If you did not register, ignore this email.`,
    html: `<p><a href="${escapeHtml(url)}">Verify email</a>, then return to Rakijazios to sign in.</p><p>This link expires in one hour. If you did not register, ignore this email.</p>`,
  };
}

export function magicLinkEmail(email: string, url: string): TransactionalEmail {
  return {
    to: email,
    subject: "Sign in to Rakijazios",
    text: [
      "Sign in to Rakijazios using this link:",
      "",
      url,
      "",
      "This link expires in 15 minutes. If you did not request this, ignore this email.",
    ].join("\n"),
    html: `<p><a href="${escapeHtml(url)}">Sign in to Rakijazios</a></p><p>This link expires in 15 minutes. If you did not request this, ignore this email.</p>`,
  };
}

export function passwordResetEmail(
  user: { id: string; email: string; name: string },
  resetUrl: string,
): TransactionalEmail {
  const name = user.name.trim() || "there";
  const safeName = escapeHtml(name);
  const safeUrl = escapeHtml(resetUrl);
  return {
    to: user.email,
    subject: "Reset your Rakijazios password",
    text: [
      `Hi ${name},`,
      "",
      "Reset your Rakijazios password using this link:",
      resetUrl,
      "",
      "This link expires in one hour. If you did not request this, you can ignore this email.",
    ].join("\n"),
    html: `<p>Hi ${safeName},</p><p>Reset your Rakijazios password:</p><p><a href="${safeUrl}">Reset password</a></p><p>This link expires in one hour. If you did not request this, you can ignore this email.</p>`,
  };
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
}

export type Auth = ReturnType<typeof createAuth>;

/**
 * Force magic-link verify URL and all callbackURL* params onto one origin so the
 * session cookie set during verify is sent on the post-login redirect.
 */
export function alignMagicLinkToOrigin(url: string, canonicalOrigin: string): string {
  try {
    const canonical = new URL(canonicalOrigin);
    const parsed = new URL(url);
    parsed.protocol = canonical.protocol;
    parsed.host = canonical.host;
    for (const key of ["callbackURL", "newUserCallbackURL", "errorCallbackURL"]) {
      const raw = parsed.searchParams.get(key);
      if (!raw) continue;
      try {
        const callback = new URL(raw, canonical.origin);
        callback.protocol = canonical.protocol;
        callback.host = canonical.host;
        parsed.searchParams.set(key, callback.href);
      } catch {
        // leave invalid callback alone; better-auth will reject it
      }
    }
    return parsed.href;
  } catch {
    return url;
  }
}

/** Assemble Better Auth trustedOrigins, adding localhost↔127.0.0.1 twins for loopback. */
export function buildTrustedOrigins(env: Pick<AuthEnv, "webOrigin" | "baseURL" | "extraOrigins">) {
  const configured = [env.webOrigin, env.baseURL, ...(env.extraOrigins ?? [])];
  const twins = [env.webOrigin, env.baseURL].flatMap((origin) => [
    ...loopbackTwinOrigins(origin),
    ...samePortLoopbackOrigins(origin),
  ]);
  return [...new Set([...configured, ...twins].filter(Boolean))];
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

/**
 * When the configured origin is a LAN IP (friends join via Wi‑Fi), also trust
 * localhost/127.0.0.1 on the same port so the host can still open 127.0.0.1.
 */
function samePortLoopbackOrigins(origin: string): string[] {
  try {
    const url = new URL(origin);
    if (isLoopbackHost(url.hostname)) return [];
    if (url.protocol !== "http:" && url.protocol !== "https:") return [];
    const out: string[] = [];
    for (const host of ["localhost", "127.0.0.1"] as const) {
      const twin = new URL(origin);
      twin.hostname = host;
      out.push(twin.origin);
    }
    return out;
  } catch {
    return [];
  }
}

/** Same-scheme/port localhost and 127.0.0.1 variants when `origin` is loopback. */
function loopbackTwinOrigins(origin: string): string[] {
  try {
    const url = new URL(origin);
    if (!isLoopbackHost(url.hostname)) return [];
    const twins: string[] = [];
    for (const host of ["localhost", "127.0.0.1"] as const) {
      if (host === url.hostname) continue;
      const twin = new URL(origin);
      twin.hostname = host;
      twins.push(twin.origin);
    }
    return twins;
  } catch {
    return [];
  }
}

export const blockedAuthPaths = [
  "/organization/create",
  "/organization/invite",
  "/organization/accept-invitation",
  "/organization/reject-invitation",
  "/organization/remove-member",
  "/organization/update-member-role",
];
