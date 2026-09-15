import NextAuth, { type NextAuthConfig } from "next-auth";
import Nodemailer from "next-auth/providers/nodemailer";
import Resend from "next-auth/providers/resend";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@/lib/db/client";
import { ensureWorkspaceForUser, getPrimaryWorkspace } from "@/lib/workspace";
import { isEmailAllowedToSignIn } from "@/lib/env";

type AdapterPrismaClient = Parameters<typeof PrismaAdapter>[0];

const emailFrom = process.env.EMAIL_FROM ?? "OpenReply <login@example.com>";
// Setting EMAIL_SERVER switches magic links to your own SMTP server, for
// self-hosters who do not want a third-party mail service. Resend stays the
// default, so an existing deployment is unaffected.
const smtpServer = process.env.EMAIL_SERVER;

/**
 * Provider id the login form has to sign in with. It differs per transport,
 * so it is derived here rather than hardcoded at the call site.
 */
export const EMAIL_PROVIDER_ID = smtpServer ? "nodemailer" : "resend";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function magicLinkEmail(url: string, host: string) {
  const safeUrl = escapeHtml(url);
  const safeHost = escapeHtml(host);
  return {
    subject: `Seu link de acesso ao OpenReply`,
    text: `Acesse o OpenReply (${host}) pelo link abaixo:\n\n${url}\n\nSe você não pediu este email, pode ignorá-lo.\n`,
    html: `<body style="background:#f4f4f5;margin:0;padding:24px;font-family:Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;">
    <tr><td style="font-size:20px;font-weight:600;color:#18181b;padding-bottom:12px;">Entrar no OpenReply</td></tr>
    <tr><td style="font-size:14px;color:#3f3f46;padding-bottom:24px;">Clique no botão abaixo para acessar o painel em <strong>${safeHost}</strong>.</td></tr>
    <tr><td style="padding-bottom:24px;"><a href="${safeUrl}" target="_blank" style="display:inline-block;background:#f97316;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:12px 20px;border-radius:8px;">Entrar</a></td></tr>
    <tr><td style="font-size:12px;color:#71717a;">Se você não pediu este email, pode ignorá-lo com segurança.</td></tr>
  </table>
</body>`,
  };
}

export const authConfig = {
  adapter: PrismaAdapter(prisma as unknown as AdapterPrismaClient),
  providers: [
    smtpServer
      ? Nodemailer({
          server: smtpServer,
          from: emailFrom,
          async sendVerificationRequest({ identifier, url, provider }) {
            const { createTransport } = await import("nodemailer");
            const { host } = new URL(url);
            const content = magicLinkEmail(url, host);
            await createTransport(provider.server).sendMail({
              to: identifier,
              from: provider.from,
              ...content,
            });
          },
        })
      : Resend({
          apiKey: process.env.RESEND_API_KEY ?? "missing-resend-api-key",
          from: emailFrom,
          async sendVerificationRequest({ identifier, url, provider }) {
            const { host } = new URL(url);
            const response = await fetch("https://api.resend.com/emails", {
              method: "POST",
              headers: {
                Authorization: `Bearer ${provider.apiKey}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                from: provider.from,
                to: identifier,
                ...magicLinkEmail(url, host),
              }),
            });
            if (!response.ok) {
              throw new Error(
                "Resend error: " + JSON.stringify(await response.json())
              );
            }
          },
        }),
  ],
  callbacks: {
    // Runs before the magic link is sent, so a blocked address never receives
    // one, and again when the link is verified.
    async signIn({ user }) {
      return isEmailAllowedToSignIn(user?.email);
    },
    async session({ session, user }) {
      if (session.user) {
        session.user.id = user.id;
      }
      return session;
    },
  },
  events: {
    async createUser({ user }) {
      if (user.id) {
        await ensureWorkspaceForUser(user.id, user.email);
      }
    },
  },
  pages: {
    signIn: "/login",
    verifyRequest: "/verify-request",
  },
  session: {
    strategy: "database",
  },
  trustHost: true,
  secret: process.env.NEXTAUTH_SECRET,
} satisfies NextAuthConfig;

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);

export async function getCurrentUserId(): Promise<string | null> {
  const session = await auth();
  return session?.user?.id ?? null;
}

export async function getCurrentWorkspaceId(): Promise<string | null> {
  const userId = await getCurrentUserId();
  if (!userId) return null;

  const workspace = await getPrimaryWorkspace(userId);
  if (workspace) return workspace.id;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });

  const createdWorkspace = await ensureWorkspaceForUser(userId, user?.email);
  return createdWorkspace.id;
}
